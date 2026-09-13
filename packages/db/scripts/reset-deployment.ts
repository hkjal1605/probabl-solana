/** Operator-only, backed-up reset for the explicitly identified Probabl deployment. */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { createDatabase, loadDatabaseOptions } from "../src/connection.ts";

async function main() {
  const action = process.argv[2];
  if (action !== "backup" && action !== "reset")
    throw new Error("Choose backup or reset explicitly");
  const options = loadDatabaseOptions(process.env, "probabl-deployment-reset");
  const target = new URL(options.connectionString);
  if (
    target.hostname !== "probabl.cluster-c3uuueq6kfve.ap-northeast-1.rds.amazonaws.com" ||
    target.pathname !== "/postgres" ||
    target.username !== "postgres" ||
    target.searchParams.get("sslmode") !== "verify-full" ||
    options.chainId !== 4663
  )
    throw new Error("Unexpected database target, administrator, TLS mode or chain");
  const previousExchange = process.env.RESET_PREVIOUS_EXCHANGE?.toLowerCase();
  const previousSchema = process.env.RESET_PREVIOUS_INDEXER_SCHEMA;
  if (
    !previousExchange ||
    !/^0x[0-9a-f]{40}$/.test(previousExchange) ||
    !previousSchema ||
    !/^probabl_indexer_[a-z0-9_]{1,29}$/.test(previousSchema)
  )
    throw new Error("Explicit previous exchange and indexer schema are required");
  const schemas = [
    "gateway",
    "operations",
    "probabl",
    "probabl_migrations",
    previousSchema,
    `cs_sync_${previousSchema}`,
  ].sort();
  const directory = resolve(process.env.RESET_BACKUP_DIRECTORY ?? "");
  if (!/^\/var\/backups\/probabl\/redeploy-[a-z0-9-]+$/.test(directory))
    throw new Error("Expected a dedicated database backup directory");
  const dumpPath = resolve(directory, "database.dump");
  const evidencePath = resolve(directory, "database-backup.json");
  const pool = new Pool({
    connectionString: options.connectionString,
    max: 1,
    connectionTimeoutMillis: 10000,
    statement_timeout: 60000,
  });
  try {
    const inventory = await pool.query<{ schema: string }>(
      "SELECT nspname AS schema FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname NOT IN ('information_schema', 'public') ORDER BY nspname",
    );
    if (JSON.stringify(inventory.rows.map((row) => row.schema)) !== JSON.stringify(schemas))
      throw new Error("Database schemas differ from the reviewed reset scope");
    const identity = await pool.query(
      "SELECT chain_id::text, exchange, order_version FROM probabl.deployment_identity WHERE id = 1",
    );
    if (
      identity.rows.length !== 1 ||
      identity.rows[0].chain_id !== "4663" ||
      identity.rows[0].exchange !== previousExchange ||
      identity.rows[0].order_version !== 3
    )
      throw new Error("Previous deployment identity differs from the authorized reset");
    const sessions = await pool.query(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND usename IN ('probabl_api', 'probabl_indexer', 'probabl_reconciler', 'probabl_polymarket')",
    );
    if (sessions.rows[0].count !== 0)
      throw new Error("Stop all backend service connections before backup/reset");
    if (action === "backup") {
      if (existsSync(dumpPath) || existsSync(evidencePath))
        throw new Error("Refusing to overwrite a database backup");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const proc = Bun.spawn(["pg_dump", "--format=custom", "--file", dumpPath], {
        env: {
          ...process.env,
          PGHOST: target.hostname,
          PGPORT: target.port || "5432",
          PGDATABASE: "postgres",
          PGUSER: "postgres",
          PGPASSWORD: decodeURIComponent(target.password),
          PGSSLMODE: "verify-full",
          PGSSLROOTCERT: target.searchParams.get("sslrootcert") ?? "",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      if ((await proc.exited) !== 0)
        throw new Error("Database backup failed; database has not been cleared");
      chmodSync(dumpPath, 0o600);
      const check = Bun.spawn(["pg_restore", "--list", dumpPath], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [toc] = await Promise.all([
        new Response(check.stdout).text(),
        new Response(check.stderr).text(),
      ]);
      if (
        (await check.exited) !== 0 ||
        !toc.includes("deployment_identity") ||
        !toc.includes(previousSchema)
      )
        throw new Error("Backup archive verification failed");
      const evidence = {
        database: "postgres",
        previousExchange,
        schemas,
        createdAt: new Date().toISOString(),
        sha256: createHash("sha256").update(readFileSync(dumpPath)).digest("hex"),
        bytes: readFileSync(dumpPath).byteLength,
      };
      writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      console.info(JSON.stringify({ event: "database.backup.verified", directory, ...evidence }));
      return;
    }
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    if (
      evidence.previousExchange !== previousExchange ||
      evidence.sha256 !== createHash("sha256").update(readFileSync(dumpPath)).digest("hex") ||
      JSON.stringify(evidence.schemas) !== JSON.stringify(schemas)
    )
      throw new Error("Verified backup does not match this reset");
    if (options.exchange.toLowerCase() === previousExchange)
      throw new Error("Configure the NEW exchange before resetting");
    await pool.query("BEGIN");
    try {
      await pool.query("SET LOCAL lock_timeout = '10s'");
      for (const schema of schemas) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
    const database = createDatabase(options);
    try {
      await database.migrate();
    } finally {
      await database.close();
    }
    await pool.query(readFileSync(resolve(import.meta.dir, "../provision-roles.sql"), "utf8"));
    console.info(
      JSON.stringify({
        event: "database.reset.completed",
        removedSchemas: schemas,
        newExchange: options.exchange,
        backupDirectory: directory,
        preserved: "database, service logins, role memberships, public/system schemas",
      }),
    );
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  // Never let driver/subprocess diagnostics expose administrator credentials.
  console.error(
    "Database backup/reset failed; inspect the target, service state and verified backup before retrying. Credentials withheld.",
  );
  process.exitCode = 1;
});
