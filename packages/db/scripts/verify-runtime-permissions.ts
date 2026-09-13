/** Read-only verification of the four service privilege boundaries. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { Client } from "pg";

const root = resolve(import.meta.dir, "../../..");
const cases = [
  ["api", "gateway.auth_sessions"],
  ["indexer", "probabl.deployment_identity"],
  ["reconciler", "operations.reconciliation_runs"],
  ["polymarket", "operations.polymarket_ticks"],
] as const;

for (const [service, readable] of cases) {
  const file = service === "api" ? ".env" : `.env.${service}`;
  const connectionString = parseEnv(readFileSync(resolve(root, file), "utf8")).DATABASE_URL;
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 10_000,
    options: "-c default_transaction_read_only=on -c statement_timeout=10000",
  });
  try {
    await client.connect();
    const result = await client.query(
      `WITH relations AS (
        SELECT c.oid, n.nspname || '.' || c.relname AS name
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      ) SELECT current_user AS username, rolsuper, rolcreatedb, rolcreaterole,
        rolreplication, rolbypassrls,
        has_table_privilege(current_user, (SELECT oid FROM relations WHERE name = $1), 'SELECT') AS expected_read,
        has_table_privilege(current_user, (SELECT oid FROM relations WHERE name = 'gateway.auth_sessions'), 'INSERT') AS auth_write,
        has_table_privilege(current_user, (SELECT oid FROM relations WHERE name = 'operations.reconciliation_runs'), 'INSERT') AS reconciliation_write,
        has_table_privilege(current_user, (SELECT oid FROM relations WHERE name = 'operations.polymarket_ticks'), 'INSERT') AS polymarket_write,
        has_table_privilege(current_user, (SELECT oid FROM relations WHERE name = 'probabl_migrations.__drizzle_migrations'), 'INSERT') AS migration_write,
        has_database_privilege(current_user, current_database(), 'CREATE') AS database_create,
        pg_has_role(current_user, 'rds_superuser', 'MEMBER') AS aurora_superuser
        FROM pg_roles WHERE rolname = current_user`,
      [readable],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.username !== `probabl_${service}` ||
      !row.expected_read ||
      row.rolsuper ||
      row.rolcreatedb ||
      row.rolcreaterole ||
      row.rolreplication ||
      row.rolbypassrls ||
      row.migration_write ||
      row.aurora_superuser ||
      row.auth_write !== (service === "api") ||
      row.reconciliation_write !== (service === "reconciler") ||
      row.polymarket_write !== (service === "polymarket") ||
      row.database_create !== (service === "indexer")
    )
      throw new Error("Unexpected runtime database privileges");
    console.log(JSON.stringify({ service, leastPrivilegeVerified: true, ...row }));
  } finally {
    await client.end();
  }
}
