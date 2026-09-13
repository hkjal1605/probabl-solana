/** Read-only storage/checkpoint inspection, using the indexer's own login. */
import { Client } from "pg";

const schema = process.env.DATABASE_SCHEMA;
if (!schema || !/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error("Invalid DATABASE_SCHEMA");
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10_000,
  options: "-c default_transaction_read_only=on -c statement_timeout=10000",
});
try {
  await client.connect();
  const state = await client.query(`SELECT * FROM "${schema}".indexer_state`);
  const checkpoint = await client.query(`SELECT * FROM "${schema}"._ponder_checkpoint`);
  const anchors = await client.query(`SELECT count(*)::int AS retained_blocks,
    min(number)::text AS oldest_block, max(number)::text AS newest_block
    FROM "${schema}".chain_block`);
  const size = await client.query(
    "SELECT pg_database_size(current_database())::text AS database_bytes",
  );
  console.log(
    JSON.stringify({
      state: state.rows,
      checkpoint: checkpoint.rows,
      ...anchors.rows[0],
      ...size.rows[0],
    }),
  );
} finally {
  await client.end();
}
