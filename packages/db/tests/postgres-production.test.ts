import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { databaseUrl, loadDatabaseOptions } from "../src/connection.ts";
import { createGatewayQueries } from "../src/gateway/queries.ts";
import { testDatabase } from "../src/testing.ts";
import { postgresClient } from "./postgres-fixture.ts";

const address = "0x1000000000000000000000000000000000000001";
test("shared database configuration rejects local files and obsolete storage settings", () => {
  for (const value of [
    undefined,
    ":memory:",
    "/tmp/test",
    "sqlite://test",
    "postgresql://localhost/",
  ])
    expect(() => databaseUrl(value)).toThrow();
  expect(() => loadDatabaseOptions({ API_DB_PATH: "old" }, "test")).toThrow("obsolete");
});
test("real PostgreSQL migrations preserve durable commits without trading queues", async () => {
  const fixture = await testDatabase();
  await Promise.all([fixture.database.verify(), fixture.connect().verify()]);
  const settings = await fixture.database.session.execute(sql`SHOW synchronous_commit`);
  expect(settings.rows[0]?.synchronous_commit).toBe("on");
  const obsolete = await fixture.database.session.execute(sql`
    SELECT to_regnamespace('matching') AS matching,
      to_regnamespace('settlement') AS settlement,
      to_regclass('probabl.relayer_nonces') AS nonces`);
  expect(obsolete.rows[0]).toEqual({ matching: null, settlement: null, nonces: null });
});
test("challenge consumption is atomic across connections and survives reconnect", async () => {
  const fixture = await testDatabase();
  const a = createGatewayQueries(fixture.database);
  const b = createGatewayQueries(fixture.connect());
  await a.saveChallenge("id", address, "sign me", 100n);
  const results = await Promise.all([
    a.consumeChallenge("id", address, 1n),
    b.consumeChallenge("id", address, 1n),
  ]);
  expect(results.filter((x) => x === "sign me")).toHaveLength(1);
  expect(results.filter((x) => x === null)).toHaveLength(1);
  await a.close();
  expect(await b.consumeChallenge("id", address, 1n)).toBeNull();
});

test("runtime privilege groups cannot rewrite evidence or let Ponder rebuild operational state", async () => {
  const { client } = await postgresClient();
  await client.exec(await Bun.file(new URL("../provision-roles.sql", import.meta.url)).text());
  // Check privilege groups independently of the administrative test connection's powers.
  const permission = async (role: string, table: string, access: string) =>
    (
      await client.query<{ allowed: boolean }>("SELECT has_table_privilege($1,$2,$3) AS allowed", [
        role,
        table,
        access,
      ])
    ).rows[0]?.allowed;
  expect(await permission("probabl_gateway_role", "gateway.auth_sessions", "DELETE")).toBe(true);
  expect(await permission("probabl_gateway_role", "operations.evidence_reviews", "INSERT")).toBe(
    true,
  );
  expect(await permission("probabl_gateway_role", "operations.evidence_reviews", "UPDATE")).toBe(
    false,
  );
  expect(await permission("probabl_gateway_role", "operations.evidence_reviews", "TRUNCATE")).toBe(
    false,
  );
  expect(await permission("probabl_indexer_role", "gateway.operations", "DELETE")).toBe(false);
  expect(await permission("probabl_indexer_role", "probabl.deployment_identity", "SELECT")).toBe(
    true,
  );
  expect(await permission("probabl_reconciler_role", "operations.freeze_signals", "UPDATE")).toBe(
    true,
  );
  expect(await permission("probabl_polymarket_role", "operations.polymarket_ticks", "UPDATE")).toBe(
    true,
  );
  for (const command of [
    "DROP SCHEMA gateway CASCADE",
    "TRUNCATE gateway.operations",
    "UPDATE probabl.deployment_identity SET order_version = 1",
  ])
    await expect(
      client.transaction(async (connection) => {
        await connection.query("SET LOCAL ROLE probabl_indexer_role");
        await connection.query(command);
      }),
    ).rejects.toThrow();
  await client.transaction(async (connection) => {
    await connection.query("SET LOCAL ROLE probabl_indexer_role");
    await connection.query("CREATE SCHEMA fixture_indexer_projection");
    await connection.query("CREATE TABLE fixture_indexer_projection.head (id integer PRIMARY KEY)");
    await connection.query("INSERT INTO fixture_indexer_projection.head VALUES (1)");
    await connection.query("DROP SCHEMA fixture_indexer_projection CASCADE");
  });
  expect(
    (await client.query("SELECT order_version FROM probabl.deployment_identity")).rows[0]
      ?.order_version,
  ).toBe(3);
});
