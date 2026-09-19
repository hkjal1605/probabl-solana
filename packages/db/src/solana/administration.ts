import { Client } from "pg";
import { databaseUrl } from "../postgres-url.ts";

const identifier = (value: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error("Invalid database identifier");
  return `"${value}"`;
};

const runtime = {
  api: { role: "probabl_sol_api", schema: "solana_api" },
  indexer: { role: "probabl_sol_indexer", schema: "solana_indexer" },
  polymarket: { role: "probabl_sol_polymarket", schema: "operations" },
} as const;

type RuntimeService = keyof typeof runtime;

async function connected<T>(connectionString: string, work: (client: Client) => Promise<T>) {
  const client = new Client({
    connectionString: databaseUrl(connectionString),
    connectionTimeoutMillis: 15_000,
  });
  try {
    await client.connect();
    return await work(client);
  } finally {
    await client.end();
  }
}

export async function provisionRuntimeRoles(
  connectionString: string,
  database: string,
  credentials: Record<RuntimeService, string>,
) {
  return connected(connectionString, async (client) => {
    await client.query("BEGIN");
    try {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('probabl-runtime-provision'))");
      for (const [service, definition] of Object.entries(runtime) as Array<
        [RuntimeService, (typeof runtime)[RuntimeService]]
      >) {
        const password = credentials[service];
        if (!/^[a-f0-9]{64}$/.test(password)) throw new Error("Invalid runtime credential");
        const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [
          definition.role,
        ]);
        if (exists.rowCount) throw new Error("Runtime database role already exists");
        await client.query(
          `CREATE ROLE ${identifier(definition.role)} LOGIN PASSWORD '${password}'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 12`,
        );
        await client.query(
          `GRANT CONNECT ON DATABASE ${identifier(database)} TO ${identifier(definition.role)}`,
        );
        await client.query(
          `CREATE SCHEMA ${identifier(definition.schema)} AUTHORIZATION ${identifier(definition.role)}`,
        );
        await client.query(
          `ALTER ROLE ${identifier(definition.role)} IN DATABASE ${identifier(database)}
          SET search_path TO ${identifier(definition.schema)}, pg_catalog`,
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

/** Destructive by design. The caller must separately validate the exact host/database
 * and require an explicit execution flag before invoking this operation. */
export async function resetRuntimeStorage(connectionString: string, database: string) {
  return connected(connectionString, async (client) => {
    await client.query("BEGIN");
    try {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('probabl-runtime-reset'))");
      for (const definition of Object.values(runtime)) {
        const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [
          definition.role,
        ]);
        if (role.rowCount !== 1) throw new Error("Expected runtime database role is missing");
      }
      for (const schema of [
        "solana_api",
        "solana_indexer",
        "operations",
        "probabl",
        "gateway",
        "settlement",
        "matching",
        "probabl_migrations",
      ])
        await client.query(`DROP SCHEMA IF EXISTS ${identifier(schema)} CASCADE`);
      for (const definition of Object.values(runtime)) {
        // RDS's administrator can create and grant schemas but is deliberately
        // unable to SET ROLE to the isolated runtime users. Keep the empty
        // namespace administrator-owned; every table created by a migration is
        // still owned by that runtime user.
        await client.query(`CREATE SCHEMA ${identifier(definition.schema)}`);
        await client.query(
          `GRANT USAGE, CREATE ON SCHEMA ${identifier(definition.schema)} TO ${identifier(definition.role)}`,
        );
        await client.query(
          `ALTER ROLE ${identifier(definition.role)} IN DATABASE ${identifier(database)}
          SET search_path TO ${identifier(definition.schema)}, pg_catalog`,
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function grantIndexedSnapshotRead(connectionString: string) {
  return connected(connectionString, async (client) => {
    const identity = (
      await client.query("SELECT current_user AS username,current_schema() AS schema")
    ).rows[0];
    if (identity?.username !== runtime.indexer.role || identity?.schema !== runtime.indexer.schema)
      throw new Error("Unexpected indexer database identity");
    await client.query("BEGIN");
    try {
      await client.query(
        `GRANT USAGE ON SCHEMA ${identifier(runtime.indexer.schema)} TO ${identifier(runtime.api.role)}`,
      );
      await client.query(
        `GRANT SELECT ON ${identifier(runtime.indexer.schema)}.solana_snapshots TO ${identifier(runtime.api.role)}`,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function verifyRuntimeStorage(connectionString: string, service: RuntimeService) {
  return connected(connectionString, async (client) => {
    await client.query("SET default_transaction_read_only=on");
    await client.query("SET statement_timeout=10000");
    const definition = runtime[service];
    const row = (
      await client.query(`SELECT current_user AS username, current_schema() AS schema,
      rolsuper, rolcreatedb, rolcreaterole, rolbypassrls,
      has_schema_privilege(current_user,'solana_api','USAGE') AS api_schema,
      has_schema_privilege(current_user,'solana_indexer','USAGE') AS indexer_schema,
      has_schema_privilege(current_user,'public','CREATE') AS public_create,
      ssl, version AS tls_version FROM pg_roles CROSS JOIN pg_stat_ssl
      WHERE rolname=current_user AND pid=pg_backend_pid()`)
    ).rows[0];
    if (
      row?.username !== definition.role ||
      row.schema !== definition.schema ||
      row.rolsuper ||
      row.rolcreatedb ||
      row.rolcreaterole ||
      row.rolbypassrls ||
      row.public_create ||
      !row.ssl ||
      row.api_schema !== (service === "api") ||
      row.indexer_schema !== (service === "indexer" || service === "api")
    )
      throw new Error("Runtime database isolation verification failed");
    if (service === "api") {
      await client.query("SELECT 1 FROM solana_indexer.solana_snapshots LIMIT 0");
      for (const table of [
        "solana_sessions",
        "solana_auth_challenges",
        "solana_evidence",
        "solana_evidence_actions",
        "solana_attachments",
      ])
        await client.query(`SELECT 1 FROM ${identifier(table)} LIMIT 0`);
    } else if (service === "indexer") {
      for (const table of ["solana_snapshots", "solana_history_cursors"])
        if (
          (await client.query(`SELECT count(*) AS count FROM ${identifier(table)}`)).rows[0]
            ?.count !== "1"
        )
          throw new Error("Indexer has not published its initial deployment state");
      await client.query("SELECT 1 FROM solana_events LIMIT 0");
    } else {
      await client.query("SELECT 1 FROM operations.polymarket_subscriptions LIMIT 0");
    }
    return row;
  });
}
