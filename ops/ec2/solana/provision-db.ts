/** One-time bootstrap; application processes never use this administrator URL. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { Client } from "pg";
import {
  createDatabase,
  loadDatabaseOptions,
} from "../../../packages/db/src/connection.ts";

const root = resolve(import.meta.dir, "../../..");
const envRoot = resolve(root, ".local/ec2/env");
const bootstrap = parseEnv(
  readFileSync(resolve(envRoot, "bootstrap.env"), "utf8"),
);
const options = loadDatabaseOptions(bootstrap, "probabl-sol-bootstrap");
const adminUrl = new URL(options.connectionString);
const qid = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const client = new Client({
  connectionString: options.connectionString,
  connectionTimeoutMillis: 15000,
});
const database = createDatabase(options);
try {
  if (
    adminUrl.hostname !==
      "probabl-solana-db.cluster-c3uuueq6kfve.ap-northeast-1.rds.amazonaws.com" ||
    adminUrl.pathname !== "/postgres" ||
    adminUrl.searchParams.get("sslmode") !== "verify-full" ||
    bootstrap.SOLANA_GENESIS_HASH !==
      "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
  )
    throw new Error("Unexpected bootstrap target");
  await client.connect();
  const identity = await client.query(
    "SELECT to_regclass('probabl.deployment_identity') AS identity",
  );
  if (identity.rows[0].identity) {
    const existing = await client.query(
      "SELECT * FROM probabl.deployment_identity",
    );
    if (
      existing.rows.length !== 1 ||
      existing.rows[0].exchange !== options.solanaNamespace ||
      String(existing.rows[0].chain_id) !== "1" ||
      existing.rows[0].order_version !== 4
    )
      throw new Error(
        "Refusing migrations against another deployment's database",
      );
  } else {
    const occupied = await client.query(
      `SELECT nspname FROM pg_namespace
      WHERE nspname = ANY($1::text[])`,
      [
        [
          "probabl",
          "gateway",
          "operations",
          "settlement",
          "matching",
          "probabl_migrations",
        ],
      ],
    );
    if (occupied.rowCount)
      throw new Error(
        "Application schemas exist without a verified deployment identity",
      );
  }
  const credentials = ["api", "indexer", "polymarket"].map((service) => {
    const env = parseEnv(
      readFileSync(resolve(envRoot, `${service}.env`), "utf8"),
    );
    const url = new URL(env.DATABASE_URL ?? "");
    if (
      url.host !== adminUrl.host ||
      url.pathname !== adminUrl.pathname ||
      url.username !== `probabl_sol_${service}` ||
      !/^[a-f0-9]{64}$/.test(url.password) ||
      url.search !== adminUrl.search
    )
      throw new Error("Invalid staged runtime credentials");
    return {
      service,
      role: url.username,
      password: url.password,
      url: url.toString(),
    };
  });
  for (const { role } of credentials) {
    const exists = await client.query(
      "SELECT 1 FROM pg_roles WHERE rolname=$1",
      [role],
    );
    if (exists.rowCount)
      throw new Error(
        "Runtime role already exists; do not recreate or rotate it implicitly",
      );
  }
  await database.migrate();
  await client.query("BEGIN");
  for (const { role, password, service } of credentials) {
    // Passwords are generated 64-character hex, never supplied SQL fragments.
    await client.query(`CREATE ROLE ${qid(role)} LOGIN PASSWORD '${password}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 12`);
    await client.query(
      `GRANT CONNECT ON DATABASE ${qid(decodeURIComponent(adminUrl.pathname.slice(1)))} TO ${qid(role)}`,
    );
    if (service !== "polymarket") {
      const schema = `solana_${service}`;
      await client.query(
        `GRANT ${qid(role)} TO ${qid(decodeURIComponent(adminUrl.username))}`,
      );
      await client.query(
        `CREATE SCHEMA ${qid(schema)} AUTHORIZATION ${qid(role)}`,
      );
      await client.query(
        `ALTER ROLE ${qid(role)} IN DATABASE postgres SET search_path TO ${qid(schema)}, pg_catalog`,
      );
    } else {
      await client.query(
        `GRANT USAGE ON SCHEMA probabl, probabl_migrations, operations TO ${qid(role)}`,
      );
      await client.query(
        `GRANT SELECT ON probabl.deployment_identity, probabl_migrations.__drizzle_migrations TO ${qid(role)}`,
      );
      await client.query(`GRANT SELECT, INSERT ON operations.polymarket_snapshots, operations.polymarket_subscriptions,
        operations.polymarket_alerts TO ${qid(role)}`);
      await client.query(
        `GRANT SELECT, INSERT, UPDATE ON operations.polymarket_heads, operations.polymarket_ticks TO ${qid(role)}`,
      );
      await client.query(`GRANT USAGE, SELECT ON SEQUENCE operations.polymarket_subscriptions_sequence_seq,
        operations.polymarket_alerts_sequence_seq TO ${qid(role)}`);
    }
  }
  await client.query("COMMIT");
  for (const { service, url } of credentials) {
    const runtime = new Client({
      connectionString: url,
      connectionTimeoutMillis: 10000,
    });
    try {
      await runtime.connect();
      const result =
        await runtime.query(`SELECT current_user AS username, current_schema() AS schema,
        rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname=current_user`);
      console.log(JSON.stringify({ service, ...result.rows[0] }));
    } finally {
      await runtime.end();
    }
  }
  console.log(
    JSON.stringify({ provisioned: true, adminUsedByServices: false }),
  );
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(
    JSON.stringify({
      provisioned: false,
      code: (error as { code?: string }).code ?? "PROVISION_CHECK_FAILED",
    }),
  );
  process.exitCode = 1;
} finally {
  await client.end();
  await database.close();
}
