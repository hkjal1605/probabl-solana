import {
  createPolymarketDatabase,
  initializePolymarketStorage,
} from "../src/polymarket/queries.ts";

// Does not load deployment secrets or choose a database implicitly.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const pool = createPolymarketDatabase(connectionString);
try {
  await initializePolymarketStorage(pool);
  console.log("Polymarket schema ready");
} finally {
  await pool.end();
}
