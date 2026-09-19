import { afterAll } from "bun:test";
import { disposableSolanaDatabase } from "../solana/testing.ts";
import { createPolymarketDatabase, initializePolymarketStorage } from "./queries.ts";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

/** Isolated localhost database shared only for the lifetime of a test file. */
export async function testDatabase() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL must be an isolated localhost PostgreSQL URL");
  const disposable = await disposableSolanaDatabase(url);
  cleanups.push(disposable.close);
  const database = createPolymarketDatabase(disposable.connectionString);
  await initializePolymarketStorage(database, { createSchema: true });
  return {
    database,
    connectionString: disposable.connectionString,
    connect: () => createPolymarketDatabase(disposable.connectionString),
  };
}
