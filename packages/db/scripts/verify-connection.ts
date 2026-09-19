import { Pool } from "pg";
import { databaseUrl } from "../src/postgres-url.ts";

// Read-only connectivity check; never initializes or modifies a schema.
const pool = new Pool({
  connectionString: databaseUrl(process.env.DATABASE_URL),
  max: 1,
  connectionTimeoutMillis: 5000,
  statement_timeout: 5000,
  application_name: "probabl-database-check",
});
try {
  await pool.query("SELECT 1");
  console.info("PostgreSQL connection verified");
} finally {
  await pool.end();
}
