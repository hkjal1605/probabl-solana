import { createDatabase, loadDatabaseOptions } from "../src/connection.ts";

const database = createDatabase(loadDatabaseOptions(process.env, "probabl-migrate"));
try {
  await database.migrate();
  console.info("Shared PostgreSQL schema and deployment identity verified");
} finally {
  await database.close();
}
