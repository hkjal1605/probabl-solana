import { expect, test } from "bun:test";
import { type HeadReader, verifiedHead } from "../src/verified-head.ts";

const hash = `0x${"11".repeat(32)}` as const;
const state = {
  indexedBlock: 100n,
  indexedBlockHash: hash,
  indexedBlockTimestamp: 1000n,
  confirmedBlock: 98n,
  finalizedBlock: 70n,
};
const config = {
  finalityMode: "rpc-tags",
  confirmationMode: "safe",
  confirmationBlockCount: 2n,
  finalityBlockCount: 30n,
  maxHeadAgeSeconds: 30,
} as const;
const reader: HeadReader = {
  getBlock: async (input) => ({
    number: "blockNumber" in input ? input.blockNumber : input.blockTag === "safe" ? 80n : 60n,
    hash,
    timestamp: 1000n,
  }),
};
test("mainnet finality is RPC-derived, not an L2 block-depth claim", async () => {
  expect(await verifiedHead(state, reader, config, 1001n)).toMatchObject({
    confirmedBlock: 80n,
    finalizedBlock: 60n,
  });
  expect(
    await verifiedHead(state, reader, { ...config, confirmationMode: "sequencer-depth" }, 1001n),
  ).toMatchObject({ confirmedBlock: 98n, finalizedBlock: 60n });
  expect(
    await verifiedHead(state, reader, { ...config, confirmationMode: "finalized" }, 1001n),
  ).toMatchObject({ confirmedBlock: 60n, finalizedBlock: 60n });
});
test("stale heads, reorganized heads and missing RPC tags fail closed", async () => {
  await expect(verifiedHead(state, reader, config, 1100n)).rejects.toThrow("stale");
  await expect(
    verifiedHead({ ...state, indexedBlockHash: `0x${"22".repeat(32)}` }, reader, config, 1001n),
  ).rejects.toThrow("canonical");
  await expect(
    verifiedHead(
      state,
      {
        getBlock: async (input) => {
          if ("blockTag" in input) throw new Error("unsupported tag");
          return reader.getBlock(input);
        },
      },
      config,
      1001n,
    ),
  ).rejects.toThrow("unsupported");
});
