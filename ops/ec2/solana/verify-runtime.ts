/** Read-only proof of TLS, per-service schema isolation, and native DB initialization. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { Client } from "pg";

const root = resolve(import.meta.dir, "../../..");
for (const service of ["api", "indexer", "polymarket"]) {
  const env = parseEnv(
    readFileSync(resolve(root, `.local/ec2/env/${service}.env`), "utf8"),
  );
  assert(
    !Object.keys(env).some((key) => /PRIVATE_KEY|SECRET_KEY|KEYPAIR/.test(key)),
  );
  const client = new Client({
    connectionString: env.DATABASE_URL,
    connectionTimeoutMillis: 10000,
    options: "-c default_transaction_read_only=on -c statement_timeout=10000",
  });
  try {
    await client.connect();
    const {
      rows: [row],
    } =
      await client.query(`SELECT current_user AS username, current_schema() AS schema,
      rolsuper, rolcreatedb, rolcreaterole, rolbypassrls,
      has_schema_privilege(current_user,'solana_api','USAGE') AS api_schema,
      has_schema_privilege(current_user,'solana_indexer','USAGE') AS indexer_schema,
      has_schema_privilege(current_user,'public','CREATE') AS public_create,
      ssl, version AS tls_version FROM pg_roles CROSS JOIN pg_stat_ssl
      WHERE rolname=current_user AND pid=pg_backend_pid()`);
    assert.equal(row.username, `probabl_sol_${service}`);
    for (const key of [
      "rolsuper",
      "rolcreatedb",
      "rolcreaterole",
      "rolbypassrls",
      "public_create",
    ])
      assert.equal(row[key], false, `${service} ${key}`);
    assert.equal(row.ssl, true);
    assert.equal(row.api_schema, service === "api");
    assert.equal(row.indexer_schema, service === "indexer");
    if (service === "api") {
      for (const table of [
        "solana_sessions",
        "solana_auth_challenges",
        "solana_evidence",
        "solana_evidence_actions",
        "solana_attachments",
      ])
        await client.query(`SELECT 1 FROM ${table} LIMIT 0`);
    } else if (service === "indexer") {
      for (const table of ["solana_snapshots", "solana_history_cursors"])
        assert.equal(
          (await client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0]
            .count,
          "1",
        );
      await client.query("SELECT 1 FROM solana_events LIMIT 0");
    } else
      await client.query(
        "SELECT 1 FROM operations.polymarket_subscriptions LIMIT 0",
      );
    console.log(JSON.stringify({ service, ...row, initialized: true }));
  } catch (error) {
    console.error(
      JSON.stringify({
        service,
        verified: false,
        code: (error as { code?: string }).code ?? "RUNTIME_CHECK_FAILED",
      }),
    );
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
