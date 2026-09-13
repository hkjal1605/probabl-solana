import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { toHex } from "viem";
import { createIndexerQueries } from "../src/indexer/reads.ts";
import * as schema from "../src/indexer/schema.ts";
import { adjustPayoutCredit, type IndexerWriter } from "../src/indexer/writes.ts";
import { fixtureRow, postgresFixture } from "./postgres-fixture.ts";

test("outstanding payout credits preserve uint256 precision, partial withdrawals and empty-row deletion", async () => {
  const fixture = await postgresFixture();
  const { db } = fixture;
  // Adapt Ponder's keyed writer shape to the same actual PostgreSQL schema for unit isolation.
  const writer = {
    find: async (_table: unknown, key: { id: string }) =>
      (await db.select().from(schema.payoutCredit).where(eq(schema.payoutCredit.id, key.id)))[0],
    insert: () => ({
      values: (values: typeof schema.payoutCredit.$inferInsert) =>
        db.insert(schema.payoutCredit).values(values),
    }),
    update: (_table: unknown, key: { id: string }) => ({
      set: (values: Partial<typeof schema.payoutCredit.$inferInsert>) =>
        db.update(schema.payoutCredit).set(values).where(eq(schema.payoutCredit.id, key.id)),
    }),
    delete: (_table: unknown, key: { id: string }) =>
      db.delete(schema.payoutCredit).where(eq(schema.payoutCredit.id, key.id)),
  } as unknown as IndexerWriter;
  const owner = toHex(1, { size: 20 }),
    asset = toHex(2, { size: 20 });
  const huge = (1n << 256n) - 1n;
  const input = { beneficiary: owner, asset, tokenId: huge, delta: huge, blockNumber: 1n };
  try {
    await adjustPayoutCredit(writer, input);
    const queries = createIndexerQueries(db);
    expect((await queries.payoutCredits(owner))[0]?.amount).toBe(huge);
    await expect(adjustPayoutCredit(writer, { ...input, delta: 1n })).rejects.toThrow("liability");
    await adjustPayoutCredit(writer, { ...input, delta: -1n, blockNumber: 2n });
    expect((await queries.payoutCredits(owner))[0]?.amount).toBe(huge - 1n);
    await adjustPayoutCredit(writer, { ...input, delta: 1n - huge });
    expect(await queries.payoutCredits(owner)).toEqual([]);
    await expect(adjustPayoutCredit(writer, { ...input, delta: -1n })).rejects.toThrow();
    await expect(adjustPayoutCredit(writer, { ...input, delta: 0n })).rejects.toThrow();
    for (let id = 0; id < 103; id++)
      await adjustPayoutCredit(writer, { ...input, tokenId: BigInt(id), delta: 1n });
    await adjustPayoutCredit(writer, { ...input, beneficiary: asset, delta: 10n });
    const page = await queries.payoutCredits(owner);
    expect(page).toHaveLength(101);
    const after = page[99]?.id;
    if (!after) throw new Error("Missing page boundary");
    expect(await queries.payoutCredits(owner, after)).toHaveLength(3);
    expect(await queries.payoutCredits(asset)).toHaveLength(1);
    await db
      .insert(schema.indexerState)
      .values(fixtureRow(schema.indexerState, { id: "canonical" }));
    const shallow = await queries.reconciliationSnapshot(false);
    expect(shallow.rows.payoutCredits).toEqual([]);
    expect(shallow.rows.payoutTotals).toHaveLength(104);
    expect((await queries.reconciliationSnapshot(true)).rows.payoutCredits).toHaveLength(104);
  } finally {
    await fixture.client.close();
  }
});

test("bounded stale discovery excludes live, terminal, wrong-market and unconfirmed reservations", async () => {
  const fixture = await postgresFixture();
  const owner = toHex(1, { size: 20 }),
    other = toHex(2, { size: 20 }),
    marketId = toHex(1, { size: 32 });
  const template = fixtureRow(schema.order, {
    marketId,
    maker: owner,
    expiry: 1000n,
    updatedBlock: 10n,
    openNotional: 10n,
    status: "open",
    nonce: 1n,
  });
  try {
    await fixture.db
      .insert(schema.nonceFloor)
      .values({ maker: owner, minimumNonce: 2n, updatedBlock: 10n });
    const variants = [
      {},
      { expiry: 1001n }, // both nonce-invalid; expiry path deduplicates first
      { maker: other, nonce: 2n }, // expired other wallet
      { maker: other, nonce: 2n, expiry: 1001n }, // still live
      { status: "cancelled" },
      { openNotional: 0n },
      { updatedBlock: 11n },
      { marketId: toHex(2, { size: 32 }) },
    ];
    for (const [i, row] of variants.entries())
      await fixture.db
        .insert(schema.order)
        .values({ ...template, ...row, id: toHex(i, { size: 32 }), sequence: BigInt(i) });
    const rows = await createIndexerQueries(fixture.db).staleReservations({
      maker: owner,
      marketId,
      timestamp: 1000n,
      confirmedThrough: 10n,
    });
    expect(rows.map((row) => row.orderHash)).toEqual(
      [0, 1, 2].map((id) => toHex(id, { size: 32 })),
    );
    for (let i = 10; i < 50; i++)
      await fixture.db
        .insert(schema.order)
        .values({ ...template, id: toHex(i, { size: 32 }), sequence: BigInt(i) });
    const bounded = await createIndexerQueries(fixture.db).staleReservations({
      maker: owner,
      marketId,
      timestamp: 1000n,
      confirmedThrough: 10n,
    });
    expect(bounded).toHaveLength(33);
    expect(bounded.every((row) => row.maker === owner)).toBe(true);
  } finally {
    await fixture.client.close();
  }
});
