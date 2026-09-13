import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { toHex } from "viem";
import { createIndexerQueries } from "../src/indexer/reads.ts";
import * as schema from "../src/indexer/schema.ts";
import { reconciliationQuery } from "../src/indexer/snapshot.ts";
import { fixtureRow, postgresFixture } from "./postgres-fixture.ts";

let fixture: Awaited<ReturnType<typeof postgresFixture>>;
beforeAll(async () => {
  fixture = await postgresFixture({ cleanup: "file" });
}, 30_000);

test("candidate exclusions happen before the 33-row window and retain exact nonce/fee boundaries", async () => {
  const local = await postgresFixture();
  try {
    const marketId = "0xbb";
    const template = fixtureRow(schema.order, {
      marketId,
      maker: "0xcc",
      branch: 1,
      side: 1,
      status: "open",
      timeInForce: 0,
      quantity: 10n,
      remaining: 10n,
      expiry: 2000n,
      updatedBlock: 99n,
      limitPriceRawX18: 100n,
      nonce: 7n,
      maxFeeBps: 50,
    });
    const excluded: Partial<typeof template>[] = [
      { expiry: 1501n },
      { maxFeeBps: 49 },
      { nonce: 6n },
      { remaining: 0n },
      { status: "cancelled" },
      { timeInForce: 1 },
      { updatedBlock: 101n },
      { branch: 0 },
      { side: 0 },
      { marketId: "0xee" },
      { limitPriceRawX18: 101n },
    ];
    await local.db
      .insert(schema.nonceFloor)
      .values({ maker: "0xcc", minimumNonce: 7n, updatedBlock: 100n });
    let next = 1;
    for (const patch of excluded)
      for (let i = 0; i < 40; ++i) {
        await local.db.insert(schema.order).values({
          ...template,
          ...patch,
          id: toHex(next, { size: 32 }),
          sequence: BigInt(next++),
        });
      }
    for (let i = 0; i < 40; ++i)
      await local.db
        .insert(schema.order)
        .values({ ...template, id: toHex(0xf000 + i, { size: 32 }), sequence: BigInt(next++) });
    const rows = await createIndexerQueries(local.db).matchCandidates({
      marketId,
      branch: 1,
      side: 1,
      limitPriceRawX18: 100n,
      makerFeeBps: 50,
      timestamp: 1501n,
      confirmedThrough: 100n,
    });
    expect(rows).toHaveLength(33);
    expect(rows.map((row) => row.id)).toEqual(
      Array.from({ length: 33 }, (_, i) => toHex(0xf000 + i, { size: 32 })),
    );
  } finally {
    await local.client.close();
  }
});
afterAll(async () => {
  await fixture?.client.close();
});

const id = "0x11";
const exact = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

test("order history retains zero, partial and complete fills independently of cancelled escrow", async () => {
  const local = await postgresFixture();
  try {
    const cases = [
      { status: "cancelled", filled: 0n, remaining: 0n },
      { status: "cancelled", filled: 1n, remaining: 0n },
      { status: "open", filled: 1n, remaining: 1n },
      { status: "filled", filled: 2n, remaining: 0n },
    ];
    for (const [i, row] of cases.entries()) {
      await local.db.insert(schema.order).values(
        fixtureRow(schema.order, {
          ...row,
          id: toHex(i + 1, { size: 32 }),
          quantity: 2n,
          maker: "0xaa",
          sequence: BigInt(i),
        }),
      );
    }
    const queries = createIndexerQueries(local.db);
    const rows = await queries.orders({
      maker: "0xaa",
      marketId: null,
      status: undefined,
      limit: 10,
    });
    expect(rows.map(({ status, filled, remaining }) => ({ status, filled, remaining }))).toEqual(
      [...cases].reverse(),
    );
    expect((await queries.orderByHash(toHex(2, { size: 32 })))?.filled).toBe(1n);
  } finally {
    await local.client.close();
  }
});

test("reconciliation is one SQL statement and retains full v2 rows, nulls and uint256 precision", async () => {
  const { db } = fixture;
  const queries = createIndexerQueries(db);
  await expect(queries.reconciliationSnapshot(true)).rejects.toThrow("not ready");
  const huge = (1n << 256n) - 1n;
  await db
    .insert(schema.indexerState)
    .values(fixtureRow(schema.indexerState, { id: "canonical", indexedBlock: huge }));
  const market = fixtureRow(schema.market, {
    id,
    stockYesPositionId: huge,
    stockNoPositionId: null,
  });
  const order = fixtureRow(schema.order, { id, marketId: id, status: "open", quantity: huge });
  const reservation = fixtureRow(schema.reservation, {
    orderHash: id,
    amount: huge,
    tokenId: null,
  });
  await db.insert(schema.market).values(market);
  await db.insert(schema.order).values(order);
  await db.insert(schema.reservation).values([reservation, { ...reservation, orderHash: "0x22" }]);
  await db
    .insert(schema.claimBalance)
    .values(fixtureRow(schema.claimBalance, { positionId: huge, amount: huge }));
  const query = reconciliationQuery(db, true).toSQL();
  expect(query.sql).not.toContain(";");
  expect(query.sql.match(/jsonb_agg/g)).toHaveLength(10);
  const snapshot = await queries.reconciliationSnapshot(true);
  expect(snapshot.head.indexedBlock).toBe(huge);
  expect(snapshot.rows.markets as unknown).toEqual([exact(market)]);
  expect(snapshot.rows.openOrders as unknown).toEqual([exact(order)]);
  expect(snapshot.rows.reservations[0] as unknown).toEqual(exact(reservation));
  expect(snapshot.rows.reservationTotals).toEqual([
    { amount: (huge * 2n).toString(), assetAddress: id, tokenId: null },
  ]);
  expect(snapshot.rows.claimTotals).toEqual([
    { amount: huge.toString(), positionId: huge.toString() },
  ]);
  expect(snapshot.rows.resolutions).toEqual([]);
  const shallow = await queries.reconciliationSnapshot(false);
  expect(shallow.rows.openOrders).toEqual([]);
  expect(shallow.rows.reservations).toEqual([]);
  expect(shallow.rows.claimTotals).toEqual(snapshot.rows.claimTotals);
});

test("atomic candidates and bid/ask FIFO use real schema indexes through 100k historical rows", async () => {
  const { db, client } = fixture;
  // Populate historical terminal orders without committing 100k individual round trips.
  const seed = db
    .insert(schema.order)
    .values(fixtureRow(schema.order, { id: "0x99", status: "closed" }))
    .toSQL();
  await client.query(seed.sql, seed.params);
  const columns = getTableConfig(schema.order).columns.map((column) => column.name);
  await client.exec(
    `INSERT INTO protocol_order SELECT ${columns.map((name) => (name === "id" ? "'order-' || n" : `o."${name}"`)).join(",")} FROM protocol_order o CROSS JOIN generate_series(1, 100000) n WHERE o.id = '0x99'`,
  );
  for (const side of [0, 1])
    for (let sequence = 1; sequence <= 10; sequence++) {
      await db.insert(schema.order).values(
        fixtureRow(schema.order, {
          id: `0xab${side}${sequence}`,
          marketId: "0xaa",
          status: "open",
          branch: 0,
          side,
          limitPriceRawX18: BigInt(100 + Math.floor(sequence / 3)),
          sequence: BigInt(sequence),
          expiry: 1000n,
          remaining: 1n,
          quantity: 1n,
        }),
      );
    }
  await client.exec("ANALYZE");
  const queries = createIndexerQueries(db);
  const cases = [
    [
      "bids",
      queries.matchCandidates({
        marketId: "0xaa",
        branch: 0,
        side: 0,
        confirmedThrough: 100n,
        timestamp: 1n,
        makerFeeBps: 0,
        limitPriceRawX18: 101n,
      }),
      "order_book_idx",
    ],
    [
      "asks",
      queries.matchCandidates({
        marketId: "0xaa",
        branch: 0,
        side: 1,
        confirmedThrough: 100n,
        timestamp: 1n,
        makerFeeBps: 0,
        limitPriceRawX18: 101n,
      }),
      "order_ask_idx",
    ],
  ] as const;
  for (const [name, builder, expectedIndex] of cases) {
    const query = builder.toSQL();
    const result = await client.query<{ "QUERY PLAN": unknown }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`,
      query.params,
    );
    const plan = JSON.stringify(result.rows);
    expect(plan).toContain(expectedIndex);
    expect(plan).not.toContain('"Node Type":"Sort"');
    expect(plan).not.toMatch(/"Node Type":"Seq Scan"[^}]*"Relation Name":"protocol_order"/);
    if (process.env.DB_AUDIT_PLANS === "1") console.info(name, plan);
  }
  const bids = await cases[0][1];
  const asks = await cases[1][1];
  expect(bids.map((order) => order.sequence)).toEqual([9n, 10n, 6n, 7n, 8n, 3n, 4n, 5n]);
  expect(asks.map((order) => order.sequence)).toEqual([1n, 2n, 3n, 4n, 5n]);
  await db.delete(schema.order).where(sql`${schema.order.id} <> ${id}`);
}, 30_000);
