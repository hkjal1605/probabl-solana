/** Run after migrations with a bootstrap-admin URL; credentials are staged, never printed. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { Client } from "pg";
import { loadDatabaseOptions, openDatabase } from "../src/connection.ts";

const root = resolve(import.meta.dir, "../../..");
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const parseDatabaseUrl = (value: string) => {
  try {
    return new URL(value);
  } catch {
    throw new Error("Invalid database URL; its value was not logged");
  }
};
const administrator = parseDatabaseUrl(connectionString);
const services = [
  ["api", "probabl_gateway_role"],
  ["indexer", "probabl_indexer_role"],
  ["reconciler", "probabl_reconciler_role"],
  ["polymarket", "probabl_polymarket_role"],
] as const;
const credentials = services.map(([name, group]) => {
  const file = name === "api" ? ".env" : `.env.${name}`;
  const value = parseEnv(readFileSync(resolve(root, file), "utf8")).DATABASE_URL;
  const url = parseDatabaseUrl(value ?? "");
  if (
    url.hostname !== administrator.hostname ||
    url.port !== administrator.port ||
    url.pathname !== administrator.pathname ||
    url.username !== `probabl_${name}` ||
    !/^[a-f0-9]{64}$/.test(url.password) ||
    url.searchParams.get("sslmode") !== "verify-full"
  )
    throw new Error(`Invalid staged database credentials for ${name}`);
  return { name, group, login: url.username, password: url.password, url: url.toString() };
});

// Verify the exact migration hashes and chain identity before issuing grants.
const database = await openDatabase(
  loadDatabaseOptions(process.env, "probabl-provision-preflight"),
);
await database.close();
const client = new Client({ connectionString, connectionTimeoutMillis: 20_000 });
try {
  await client.connect();
  await client.query(readFileSync(resolve(import.meta.dir, "../provision-roles.sql"), "utf8"));
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('probabl:runtime-logins', 0))");
  for (const credential of credentials) {
    const existing = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [
      credential.login,
    ]);
    if (existing.rows.length) throw new Error("Refusing to modify an existing runtime login");
    // Identifiers are fixed above; the only secret interpolation is restricted
    // to exactly 64 hexadecimal characters. Never log these statements.
    await client.query(`CREATE ROLE "${credential.login}" LOGIN PASSWORD '${credential.password}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT CONNECTION LIMIT 24`);
    await client.query(`GRANT "${credential.group}" TO "${credential.login}"`);
  }
  await client.query("COMMIT");
  for (const credential of credentials) {
    const runtime = await openDatabase({
      ...loadDatabaseOptions(process.env, `probabl-${credential.name}-provision-check`),
      connectionString: credential.url,
    });
    await runtime.close();
    console.log(
      JSON.stringify({ service: credential.name, login: credential.login, verified: true }),
    );
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(
    JSON.stringify({
      provisioned: false,
      code: (error as { code?: string }).code ?? "PROVISION_FAILED",
    }),
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
