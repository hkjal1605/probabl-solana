/** Read-only connection/TLS diagnostic. Never emits a connection URL or password. */
import { Client } from "pg";

const connectionString = process.env.DATABASE_URL;
let client: Client | undefined;
try {
  if (!connectionString) throw new Error("DATABASE_URL is missing");
  const url = new URL(connectionString);
  if (url.searchParams.get("sslmode") !== "verify-full")
    throw new Error("Expected sslmode=verify-full");
  client = new Client({
    connectionString,
    connectionTimeoutMillis: 20_000,
    query_timeout: 10_000,
    application_name: "probabl-readonly-connection-check",
    options: "-c default_transaction_read_only=on -c statement_timeout=10000",
  });
  await client.connect();
  const result = await client.query(
    `SELECT current_database() AS database, current_user AS username,
      current_setting('server_version') AS server_version,
      current_setting('transaction_read_only') AS transaction_read_only,
      current_setting('max_connections') AS max_connections,
      pg_is_in_recovery() AS is_replica, ssl, version AS tls_version
      FROM pg_stat_ssl WHERE pid = pg_backend_pid()`,
  );
  if (result.rows[0]?.ssl !== true || result.rows[0]?.transaction_read_only !== "on")
    throw new Error("Expected a read-only TLS connection");
  const schemas = await client.query<{ schema_name: string }>(
    `SELECT schema_name FROM information_schema.schemata
     WHERE schema_name NOT LIKE 'pg_%' AND schema_name <> 'information_schema'
     ORDER BY schema_name`,
  );
  console.log(
    JSON.stringify({
      connected: true,
      certificateVerification: "verify-full",
      ...result.rows[0],
      schemas: schemas.rows.map((row) => row.schema_name),
    }),
  );
} catch (error) {
  // Driver diagnostics may include SQL or credentials. Emit only the code.
  console.error(
    JSON.stringify({
      connected: false,
      code: (error as { code?: string }).code ?? "CONNECTION_CHECK_FAILED",
    }),
  );
  process.exitCode = 1;
} finally {
  await client?.end();
}
