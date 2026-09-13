import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hash } from "viem";
import { deploymentRecovery } from "./deployment-recovery.ts";

const directory = mkdtempSync(join(tmpdir(), "probabl-deployment-recovery-"));
afterAll(() => rmSync(directory, { recursive: true }));
const account = "0x1111111111111111111111111111111111111111";
const destination = "0x2222222222222222222222222222222222222222";
const hash = `0x${"ab".repeat(32)}` as Hash;
let sequence = 0;
const journal = (overrides = {}, completed = false) => {
  const path = join(directory, `${sequence++}.jsonl`);
  const rows = [
    { event: "started", chainId: 4663, deployer: account, nonce: 16, ...overrides },
    { event: "broadcast", transactionHash: hash },
    { event: "broadcast", transactionHash: hash },
    ...(completed ? [{ event: "completed" }] : []),
  ];
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n"));
  return path;
};
function fixture(transaction = {}, receipt = {}, pending = 17, historical = 16) {
  return {
    getTransactionCount: async (args: { blockNumber?: bigint }) =>
      args.blockNumber === undefined ? pending : historical,
    getTransaction: async () => ({
      from: account,
      nonce: 16,
      chainId: 4663,
      input: "0xabcd",
      to: destination,
      ...transaction,
    }),
    getTransactionReceipt: async () => ({ blockNumber: 100n, status: "success", ...receipt }),
  } as unknown as Parameters<typeof deploymentRecovery>[0];
}

describe("deployment recovery", () => {
  test("a fresh deployment broadcasts normally", async () => {
    const recovery = await deploymentRecovery(fixture(), account, 4663);
    expect(await recovery.referenceBlock()).toBeUndefined();
    expect(await recovery.send("0xabcd", destination, async () => hash)).toBe(hash);
    recovery.assertConsumed();
  });
  test("reuses exact confirmed transactions and deduplicates retries", async () => {
    const recovery = await deploymentRecovery(fixture(), account, 4663, journal());
    expect(() => recovery.assertConsumed()).toThrow("Unused");
    expect(await recovery.referenceBlock()).toBe(99n);
    expect(
      await recovery.send("0xabcd", destination, async () => {
        throw new Error("must not broadcast");
      }),
    ).toBe(hash);
    recovery.assertConsumed();
    expect(await recovery.send("0xbeef", null, async () => hash)).toBe(hash);
  });
  test("rejects changed transaction identity, calldata or reverted receipts before broadcasting", async () => {
    for (const [transaction, receipt] of [
      [{ from: destination }, {}],
      [{ nonce: 17 }, {}],
      [{ chainId: 1 }, {}],
      [{ input: "0xbeef" }, {}],
      [{ to: null }, {}],
      [{}, { status: "reverted" }],
    ]) {
      const recovery = await deploymentRecovery(
        fixture(transaction, receipt),
        account,
        4663,
        journal(),
      );
      let broadcast = false;
      await expect(
        recovery.send("0xabcd", destination, async () => {
          broadcast = true;
          return hash;
        }),
      ).rejects.toThrow("does not match");
      expect(broadcast).toBe(false);
    }
  });
  test("rejects foreign, completed or nonce-divergent journals", async () => {
    for (const path of [
      journal({ chainId: 1 }),
      journal({ deployer: destination }),
      journal({ nonce: -1 }),
      journal({}, true),
    ])
      await expect(deploymentRecovery(fixture(), account, 4663, path)).rejects.toThrow();
    await expect(deploymentRecovery(fixture({}, {}, 18), account, 4663, journal())).rejects.toThrow(
      "intervening",
    );
  });
  test("fails closed if the historical block cannot reproduce the constructor nonce", async () => {
    const recovery = await deploymentRecovery(fixture({}, {}, 17, 15), account, 4663, journal());
    await expect(recovery.referenceBlock()).rejects.toThrow("cannot isolate");
  });
});
