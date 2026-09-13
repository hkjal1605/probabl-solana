import { afterAll, beforeAll, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  type CacheDatabase,
  checkpointBlock,
  createCacheQueries,
  isolatedCacheSchema,
} from "../src/indexer/cache.ts";
import { postgresClient } from "./postgres-fixture.ts";

let client: Awaited<ReturnType<typeof postgresClient>>["client"];
const dialect = new PgDialect();
const statements: { sql: string; params: unknown[] }[] = [];
const checkpoint = (block: number) =>
  `1700000000${"31337".padStart(16, "0")}${String(block).padStart(16, "0")}${"0".repeat(33)}`;
const database: CacheDatabase = {
  transaction: async (work) => {
    const result = await client.transaction(async (transaction) => ({
      value: await work({
        execute: (statement) => {
          const query = dialect.sqlToQuery(statement);
          statements.push(query);
          return transaction.query(query.sql, query.params);
        },
      }),
    }));
    return result.value;
  },
};

beforeAll(async () => {
  client = (await postgresClient({ cleanup: "file" })).client;
  await client.exec(`CREATE SCHEMA app; CREATE SCHEMA cs_sync_app; CREATE SCHEMA ponder_sync;
    CREATE TABLE app._ponder_checkpoint (chain_id bigint PRIMARY KEY, safe_checkpoint text, finalized_checkpoint text, latest_checkpoint text);
    CREATE TABLE app._reorg__chain_block (marker integer); INSERT INTO app._reorg__chain_block VALUES (7);
    CREATE TABLE ponder_sync.blocks (marker integer); INSERT INTO ponder_sync.blocks VALUES (9);
    CREATE TABLE cs_sync_app.intervals (fragment_id text PRIMARY KEY, chain_id bigint, blocks nummultirange);
    INSERT INTO cs_sync_app.intervals VALUES ('filter', 31337, '{[0,1001]}'), ('other', 1, '{[0,1001]}');`);
  for (const name of [
    "blocks",
    "logs",
    "transactions",
    "transaction_receipts",
    "traces",
    "rpc_request_results",
  ]) {
    const column = name === "blocks" ? "number" : "block_number";
    await client.exec(`CREATE TABLE cs_sync_app.${name} (chain_id bigint, ${column} bigint, id text);
      CREATE INDEX ${name}_range ON cs_sync_app.${name}(chain_id, ${column});
      INSERT INTO cs_sync_app.${name} SELECT 31337, n, n::text FROM generate_series(0,1000) n;
      INSERT INTO cs_sync_app.${name} VALUES (1, 0, 'other-chain');`);
  }
  await client.exec(
    "INSERT INTO cs_sync_app.rpc_request_results VALUES (31337, NULL, 'block-independent')",
  );
}, 30_000);
afterAll(async () => {
  await client?.close();
});

test("cache namespaces and checkpoint decoding reject ambiguous/unsafe identities", () => {
  expect(isolatedCacheSchema("app")).toBe("cs_sync_app");
  for (const bad of [
    "",
    "public; DROP TABLE x",
    "UPPER",
    "a".repeat(46),
    "cs_sync_app",
    "pg_catalog",
    "ponder_sync",
    "information_schema",
  ])
    expect(() => isolatedCacheSchema(bad)).toThrow();
  expect(checkpointBlock(checkpoint(123), 31337)).toBe(123n);
  expect(() => checkpointBlock(checkpoint(123), 1)).toThrow();
  expect(() => checkpointBlock("123", 31337)).toThrow();
  expect(() =>
    createCacheQueries(database, { schema: "app", chainId: 31337, retention: 0, batchSize: 128 }),
  ).toThrow();
});

test("eviction is bounded, private, atomic with coverage and behind all recovery boundaries", async () => {
  const queries = createCacheQueries(database, {
    schema: "app",
    chainId: 31337,
    retention: 64,
    batchSize: 128,
  });
  expect((await queries.prune()).deleted).toBe(0);
  await client.query("INSERT INTO app._ponder_checkpoint VALUES (31337, $1, $2, $3)", [
    checkpoint(500),
    checkpoint(600),
    checkpoint(700),
  ]);
  const result = await queries.prune();
  expect(result.cutoff).toBe(436n);
  expect(result.deleted).toBe(128 * 6);
  expect(Object.values(result.perTable).every((count) => count <= 128)).toBe(true);
  expect(
    (
      await client.query<{ old: boolean; retained: boolean }>(
        "SELECT blocks @> 435::numeric AS old, blocks @> 436::numeric AS retained FROM cs_sync_app.intervals WHERE fragment_id = 'filter'",
      )
    ).rows[0],
  ).toEqual({ old: false, retained: true });
  for (let i = 0; i < 5; i++) await queries.prune();
  expect(
    (
      await client.query<{ min: number }>(
        "SELECT min(number)::integer FROM cs_sync_app.blocks WHERE chain_id = 31337",
      )
    ).rows[0]?.min,
  ).toBe(436);
  expect((await queries.prune()).deleted).toBe(0);
  expect((await client.query("SELECT * FROM ponder_sync.blocks")).rows).toEqual([{ marker: 9 }]);
  expect((await client.query("SELECT * FROM app._reorg__chain_block")).rows).toEqual([
    { marker: 7 },
  ]);
  expect(
    (
      await client.query(
        "SELECT id FROM cs_sync_app.rpc_request_results WHERE block_number IS NULL",
      )
    ).rows,
  ).toEqual([{ id: "block-independent" }]);
  expect((await client.query("SELECT id FROM cs_sync_app.blocks WHERE chain_id = 1")).rows).toEqual(
    [{ id: "other-chain" }],
  );
  // A failed later delete must roll back the preceding coverage trim and deletes.
  await client.query(
    "UPDATE app._ponder_checkpoint SET safe_checkpoint = $1, finalized_checkpoint = $1, latest_checkpoint = $1",
    [checkpoint(900)],
  );
  await client.exec("ALTER TABLE cs_sync_app.traces RENAME TO traces_held");
  await expect(queries.prune()).rejects.toThrow();
  expect(
    (
      await client.query<{ min: number }>(
        "SELECT min(number)::integer FROM cs_sync_app.blocks WHERE chain_id = 31337",
      )
    ).rows[0]?.min,
  ).toBe(436);
  expect(
    (
      await client.query<{ retained: boolean }>(
        "SELECT blocks @> 500::numeric AS retained FROM cs_sync_app.intervals WHERE fragment_id = 'filter'",
      )
    ).rows[0]?.retained,
  ).toBe(true);
  await client.exec("ALTER TABLE cs_sync_app.traces_held RENAME TO traces");
});

test("large cache eviction uses bounded range seeks and TID deletion, not a history scan", async () => {
  await client.exec(
    "INSERT INTO cs_sync_app.blocks SELECT 31337, n, n::text FROM generate_series(1001,101000) n; ANALYZE cs_sync_app.blocks;",
  );
  await client.query(
    "UPDATE app._ponder_checkpoint SET safe_checkpoint = $1, finalized_checkpoint = $1, latest_checkpoint = $1",
    [checkpoint(100000)],
  );
  statements.length = 0;
  const queries = createCacheQueries(database, {
    schema: "app",
    chainId: 31337,
    retention: 64,
    batchSize: 128,
  });
  await queries.prune();
  const mutation = statements.find((statement) => statement.sql.includes("WITH coverage AS"));
  if (!mutation) throw new Error("missing maintenance statement");
  const result = await client.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${mutation.sql}`,
    mutation.params,
  );
  const plan = JSON.stringify(result.rows);
  expect(plan).toContain("blocks_range");
  expect(plan).toContain("Tid Scan");
  if (process.env.DB_AUDIT_PLANS) console.info(plan);
});
