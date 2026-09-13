import { expect, test } from "bun:test";
import type { IndexerQueries } from "@conditional-stocks/db/indexer/reads";
import { createCanonicalBlockReader } from "../src/canonical-block.ts";

const hash = `0x${"11".repeat(32)}` as const;
const other = `0x${"22".repeat(32)}` as const;
const state = { indexedBlock: 100n, indexedBlockHash: hash };
const block = (number: bigint) => ({
  number,
  hash,
  parentHash: other,
  timestamp: 1000n,
  chainId: 31337n,
  slot: 1,
});
const miss = { canonicalBlock: async () => undefined } as unknown as Pick<
  IndexerQueries,
  "canonicalBlock"
>;

test("retained block lookup performs no RPC and rejects future/unindexed references", async () => {
  const calls: bigint[] = [];
  const read = createCanonicalBlockReader(
    { canonicalBlock: async (number: bigint) => block(number) } as unknown as Pick<
      IndexerQueries,
      "canonicalBlock"
    >,
    {
      getBlock: async ({ blockNumber }) => {
        calls.push(blockNumber);
        return block(blockNumber);
      },
    },
    31337,
  );
  expect((await read(98n, state)).number).toBe(98n);
  expect(calls).toEqual([]);
  await expect(read(101n, state)).rejects.toThrow("indexed range");
  await expect(read(-1n, state)).rejects.toThrow("indexed range");
  await read(98n, state, true);
  expect(calls).toEqual([98n, 100n]);
});

test("evicted anchors use exact-block RPC and reverify the indexed head; concurrent misses coalesce", async () => {
  const calls: bigint[] = [];
  const read = createCanonicalBlockReader(
    miss,
    {
      getBlock: async ({ blockNumber }) => {
        calls.push(blockNumber);
        await Bun.sleep(5);
        return block(blockNumber);
      },
    },
    31337,
  );
  const results = await Promise.all(Array.from({ length: 20 }, () => read(1n, state)));
  expect(results.every((row) => row.number === 1n && row.hash === hash)).toBe(true);
  expect(calls).toEqual([1n, 100n]);
  await read(1n, state);
  expect(calls).toEqual([1n, 100n, 1n, 100n]); // No stale cross-request hash cache.
});

test("RPC failure, wrong height, changed indexed branch and retained/RPC disagreement fail closed", async () => {
  await expect(
    createCanonicalBlockReader(
      miss,
      {
        getBlock: async () => {
          throw new Error("offline");
        },
      },
      31337,
    )(1n, state),
  ).rejects.toThrow("unavailable");
  await expect(
    createCanonicalBlockReader(
      miss,
      { getBlock: async ({ blockNumber }) => block(blockNumber === 100n ? 100n : 99n) },
      31337,
    )(1n, state),
  ).rejects.toThrow("invalid historical");
  await expect(
    createCanonicalBlockReader(
      miss,
      {
        getBlock: async ({ blockNumber }) => ({
          ...block(blockNumber),
          hash: blockNumber === 100n ? other : hash,
        }),
      },
      31337,
    )(1n, state),
  ).rejects.toThrow("canonical");
  const retained = {
    canonicalBlock: async (number: bigint) => ({ ...block(number), hash: other }),
  } as unknown as Pick<IndexerQueries, "canonicalBlock">;
  await expect(
    createCanonicalBlockReader(
      retained,
      { getBlock: async ({ blockNumber }) => block(blockNumber) },
      31337,
    )(1n, state, true),
  ).rejects.toThrow("canonical");
});

test("distinct historical misses are concurrency-bounded and release capacity after completion", async () => {
  let release = () => {};
  let filled = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const full = new Promise<void>((resolve) => {
    filled = resolve;
  });
  let calls = 0;
  const read = createCanonicalBlockReader(
    miss,
    {
      getBlock: async ({ blockNumber }) => {
        if (++calls === 64) filled();
        await gate;
        return block(blockNumber);
      },
    },
    31337,
  );
  const pending = Array.from({ length: 64 }, (_, index) => read(BigInt(index + 1), state));
  await full;
  await expect(read(65n, state)).rejects.toThrow("busy");
  const coalesced = read(1n, state);
  release();
  await Promise.all([...pending, coalesced]);
  expect(calls).toBe(128);
  expect((await read(65n, state)).number).toBe(65n);
  expect(calls).toBe(130);
});
