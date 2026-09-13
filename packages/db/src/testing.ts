/** Actual isolated PostgreSQL databases for tests. Never accept a remote/production endpoint. */
import { afterAll, afterEach } from "bun:test";
import { Pool } from "pg";
import { type ApplicationDatabase, type DatabaseOptions, createDatabase } from "./connection.ts";

const cleanups: Array<() => Promise<void>> = [];
const fileCleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
afterAll(async () => {
  for (const cleanup of fileCleanups.splice(0).reverse()) await cleanup();
});

export async function testDatabase(options: { cleanup?: "test" | "file"; migrate?: boolean;
  deployment?:Pick<DatabaseOptions,"chainId"|"exchange"|"solanaNamespace"> } = {}) {
  const value = process.env.TEST_DATABASE_URL;
  if (!value)
    throw new Error("TEST_DATABASE_URL must point to an isolated local PostgreSQL test server");
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error("Tests require loopback PostgreSQL; remote databases are forbidden");
  const name = `probabl_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: value, max: 1 });
  const connections: ApplicationDatabase[] = [];
  const externalClosers: Array<() => Promise<void>> = [];
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } catch (error) {
    await admin.end();
    throw error;
  }
  url.pathname = `/${name}`;
  const connect = () => {
    const database = createDatabase({
      connectionString: url.href,
      chainId: 31337,
      exchange: "0x1000000000000000000000000000000000000001",
      ...options.deployment,
      maxConnections: 4,
      applicationName: "probabl-test",
    });
    connections.push(database);
    return database;
  };
  let cleaned = false;
  const close = async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      await Promise.all(externalClosers.map((close) => close()));
      await Promise.all(connections.map((database) => database.close()));
      // Exact name was generated here and created by this fixture, never taken from user input.
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  };
  (options.cleanup === "file" ? fileCleanups : cleanups).push(close);
  const database = connect();
  try {
    if (options.migrate !== false) await database.migrate();
  } catch (error) {
    await close();
    throw error;
  }
  return {
    database,
    db: database.session,
    connectionString: url.href,
    connect,
    close,
    registerClose: (handler: () => Promise<void>) => externalClosers.push(handler),
  };
}
