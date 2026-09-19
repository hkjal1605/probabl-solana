import { resetRuntimeStorage } from "../src/solana/administration.ts";

if (!process.argv.includes("--execute"))
  throw new Error("Database reset requires an explicit --execute flag");
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const target = new URL(connectionString);
if (
  target.hostname !== "probabl-solana-db.cluster-c3uuueq6kfve.ap-northeast-1.rds.amazonaws.com" ||
  target.pathname !== "/postgres" ||
  target.username !== "postgres" ||
  target.searchParams.get("sslmode") !== "verify-full"
)
  throw new Error("Refusing to reset an unexpected database target");

await resetRuntimeStorage(connectionString, "postgres");
console.log("Devnet application schemas cleared and recreated for the runtime roles.");
