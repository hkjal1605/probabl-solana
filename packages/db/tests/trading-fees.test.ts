import { expect, test } from "bun:test";
import type { Hex } from "viem";
import { order } from "../src/indexer/schema.ts";
import { addOrderTradingFee, type IndexerWriter } from "../src/indexer/writes.ts";

const orderHash: Hex = `0x${"11".repeat(32)}`;

test("fee projection adds exact raw amounts with one keyed update and no extra reads", async () => {
  let feesPaid = 0n;
  let updates = 0;
  // Ponder supplies the canonical row to this updater inside its reorg-aware block transaction.
  const writer = {
    update(table: unknown, key: { id: Hex }) {
      expect(table).toBe(order);
      expect(key).toEqual({ id: orderHash });
      updates++;
      return {
        async set(update: (row: { feesPaid: bigint }) => { feesPaid: bigint }) {
          feesPaid = update({ feesPaid }).feesPaid;
        },
      };
    },
  } as unknown as IndexerWriter;
  const large = (1n << 240n) + 123n;
  await addOrderTradingFee(writer, orderHash, large);
  await addOrderTradingFee(writer, orderHash, 7n);
  expect(feesPaid).toBe(large + 7n);
  expect(updates).toBe(2);
});

test("zero fee causes no database access and invalid negative fees are rejected", async () => {
  const writer = {} as IndexerWriter;
  await addOrderTradingFee(writer, orderHash, 0n);
  expect(() => addOrderTradingFee(writer, orderHash, -1n)).toThrow("nonnegative");
});
