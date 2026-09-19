import { createSolanaDatabase } from "../src/solana/connection";

// Does not load deployment secrets or choose a database implicitly.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const db = createSolanaDatabase({ connectionString, applicationName: "probabl-solana-migrations" });
try {
  await db.initialize();
  await db.verify();
  console.log("Solana schema ready");
} finally {
  await db.close();
}
