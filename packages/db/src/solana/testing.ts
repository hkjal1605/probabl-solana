import { Pool } from "pg";
/** Owns only a newly generated localhost database. No supplied name can be dropped. */
export async function disposableSolanaDatabase(connectionString: string) {
  const url = new URL(connectionString);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !["postgres:", "postgresql:"].includes(url.protocol)
  )
    throw new Error("Disposable databases require localhost PostgreSQL");
  const admin = new Pool({ connectionString, max: 1 });
  const name = "probabl_test_" + crypto.randomUUID().replaceAll("-", "");
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } catch (e) {
    await admin.end();
    throw e;
  }
  url.pathname = "/" + name;
  let closed = false;
  return {
    connectionString: url.toString(),
    async close() {
      if (closed) return;
      closed = true;
      try {
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    },
  };
}
