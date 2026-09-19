import { expect, test } from "bun:test";
import { Pool } from "pg";
import { createSolanaDatabase } from "../src/solana/connection";
import { disposableSolanaDatabase } from "../src/solana/testing";
import type { SnapshotWrite } from "../src/solana/types";

const run = test.skipIf(!process.env.TEST_DATABASE_URL);
run(
  "fresh Solana schema publishes exact custody atomically, monotonically and idempotently",
  async () => {
    const fixture = await disposableSolanaDatabase(process.env.TEST_DATABASE_URL!);
    const db = createSolanaDatabase({ connectionString: fixture.connectionString }),
      sql = new Pool({ connectionString: fixture.connectionString });
    const image: SnapshotWrite = {
      slot: 100,
      observedAt: Date.now(),
      accounts: { version: 3, healthy: true, rawAccounts: [{ address: "fixture", data: "one" }] },
      pools: [
        {
          address: "pool",
          mint: "USDC",
          token_program: "SPL",
          decimals: 6,
          liability: "18446744073709551615",
        },
      ],
      credits: [{ address: "credit", pool: "pool", owner: "alice", available: "9007199254740993" }],
      claims: [
        { market: "A", owner: "alice", mint: "USDC-A-YES", asset: 4, available: "10" },
        { market: "B", owner: "alice", mint: "USDC-B-YES", asset: 4, available: "20" },
      ],
    };
    try {
      await db.initialize();
      await db.initialize();
      await db.verify();
      expect(await db.persistSnapshot("deployment", image)).toBe(true);
      expect(
        (await sql.query("SELECT available::text FROM solana_asset_credits")).rows[0].available,
      ).toBe("9007199254740993");
      expect(
        (
          await sql.query("SELECT available::text FROM solana_market_claims ORDER BY market")
        ).rows.map((r) => r.available),
      ).toEqual(["10", "20"]);
      expect(await db.persistSnapshot("deployment", { ...image, slot: 99 })).toBe(false);
      expect(await db.persistSnapshot("deployment", { ...image, slot: 101 })).toBe(true);
      expect((await sql.query("SELECT count(*) FROM solana_asset_credits")).rows[0].count).toBe(
        "1",
      );
      await expect(
        db.persistSnapshot("deployment", {
          ...image,
          slot: 102,
          accounts: { ...image.accounts, rawAccounts: [] },
          credits: [{ ...image.credits[0]!, available: "-1" }],
        }),
      ).rejects.toThrow();
      expect((await db.snapshot("deployment"))!.slot).toBe("101");
      expect(
        (await sql.query("SELECT available::text FROM solana_asset_credits")).rows[0].available,
      ).toBe("9007199254740993");
      // One failing statement cannot publish half a balance image or watermark.
      await expect(
        db.persistSnapshot("deployment", {
          ...image,
          slot: 102,
          accounts: { ...image.accounts, rawAccounts: [] },
          credits: [{ ...image.credits[0]!, pool: "foreign" }],
        }),
      ).rejects.toThrow();
      await db.persistSnapshot("other", image);
      await db.failSnapshot("deployment", 100); // A stale failed indexer cannot poison newer state.
      expect(await db.snapshot("deployment")).toBeDefined();
      await db.failSnapshot("deployment", 101);
      expect(await db.snapshot("deployment")).toBeUndefined();
      expect(await db.snapshot("other")).toBeDefined();
      await expect(db.snapshot("other", "public;DROP TABLE x")).rejects.toThrow("schema");
      await sql.query(
        "UPDATE solana_snapshots SET observed_at=now()-interval '1 minute' WHERE domain='other'",
      );
      expect(await db.snapshot("other")).toBeUndefined();
    } finally {
      await sql.end();
      await db.close();
      await fixture.close();
    }
  },
);
run(
  "database operations preserve event deduplication, transaction rollback and single-use auth",
  async () => {
    const fixture = await disposableSolanaDatabase(process.env.TEST_DATABASE_URL!);
    const db = createSolanaDatabase({ connectionString: fixture.connectionString });
    try {
      await db.initialize();
      const event = {
        signature: "sig",
        event_index: 0,
        slot: 1,
        block_time: 1,
        name: "PoolChange",
        market: null,
        data: { pool: "pool", owner: "alice", amount: "9007199254740993" },
      };
      await db.locked("history:test", async (tx) => {
        await tx.putEvent("test", event);
        await tx.putEvent("test", event);
      });
      expect(await db.eventCount("test")).toBe(1);
      await expect(
        db.locked("history:test", async (tx) => {
          await tx.putEvent("test", { ...event, event_index: 1 });
          throw new Error("abort");
        }),
      ).rejects.toThrow("abort");
      expect(await db.eventCount("test")).toBe(1);
      await db.locked("auth:test", (tx) =>
        tx.createChallenge("test", "alice", "challenge", "message"),
      );
      expect(await db.challenge("other", "alice", "challenge")).toBeUndefined();
      const consumed = await Promise.allSettled(
        ["token1", "token2"].map((token) =>
          db.locked("auth:test", (tx) => tx.consumeChallenge("test", "alice", "challenge", token)),
        ),
      );
      expect(consumed.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await db.challenge("test", "alice", "challenge")).toBeUndefined();
      await db.locked("evidence:test", async (tx) => {
        await tx.putEvidence("test", "hash", { kind: "fixture" });
        await tx.audit("test", "hash", "PREPARE", "alice", {});
      });
      expect(await db.evidence("test", "hash")).toEqual({ kind: "fixture" });
      expect(await db.evidence("other", "hash")).toBeUndefined();
      expect(await db.evidenceActions("test", "hash")).toHaveLength(1);
      const original = await db.recordDelegatedSubmission(
        "test",
        "order",
        "terms-hash",
        "alice",
        "delegate",
        "signature",
        Uint8Array.from([1, 2, 3]),
        123,
      );
      expect(original.signed_transaction).toEqual(Buffer.from([1, 2, 3]));
      expect(original.order_terms_hash).toBe("terms-hash");
      const repeated = await db.recordDelegatedSubmission(
        "test",
        "order",
        "different-terms",
        "alice",
        "delegate",
        "different",
        Uint8Array.from([4]),
        999,
      );
      expect(repeated.signature).toBe("signature");
      expect(repeated.order_terms_hash).toBe("terms-hash");
      expect(await db.delegatedSubmissionCount("test", "alice")).toBe(1);
      expect(await db.delegatedSubmission("other", "order")).toBeUndefined();
    } finally {
      await db.close();
      await fixture.close();
    }
  },
);
run("old or incompatible custody schemas require an explicit fresh database", async () => {
  const fixture = await disposableSolanaDatabase(process.env.TEST_DATABASE_URL!);
  const db = createSolanaDatabase({ connectionString: fixture.connectionString }),
    sql = new Pool({ connectionString: fixture.connectionString });
  try {
    await sql.query("CREATE TABLE solana_snapshots (legacy boolean)");
    await expect(db.initialize()).rejects.toThrow("fresh database");
    expect(
      (
        await sql.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name='solana_snapshots'",
        )
      ).rows.map((r) => r.column_name),
    ).toEqual(["legacy"]);
  } finally {
    await sql.end();
    await db.close();
    await fixture.close();
  }
});
