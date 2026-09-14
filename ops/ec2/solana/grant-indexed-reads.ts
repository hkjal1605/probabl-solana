/** Narrow upgrade for isolated EC2 schemas; uses the existing table owner's login. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { Client } from "pg";

const root = resolve(import.meta.dir, "../../..");
const env = parseEnv(readFileSync(resolve(root, ".local/ec2/env/indexer.env"), "utf8"));
const client = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 10000 });
try {
  await client.connect();
  const { rows: [identity] } = await client.query("SELECT current_user AS username,current_schema() AS schema");
  if (identity.username !== "probabl_sol_indexer" || identity.schema !== "solana_indexer")
    throw new Error("Unexpected indexer database identity");
  await client.query("BEGIN");
  await client.query("GRANT USAGE ON SCHEMA solana_indexer TO probabl_sol_api");
  await client.query("GRANT SELECT ON solana_indexer.solana_snapshots TO probabl_sol_api");
  await client.query("COMMIT");
  console.log("API granted read-only access to the indexed snapshot table.");
} finally { await client.end(); }
