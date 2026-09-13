import { describe, expect, test } from "bun:test";
import { createReconciliationQueries } from "@conditional-stocks/db/reconciliation";
import type {
  ReconciliationIssue,
  ReconciliationReport,
  ReconciliationSnapshot,
} from "@conditional-stocks/db/reconciliation/types";
import { testDatabase } from "@conditional-stocks/db/testing";
import type { Hex } from "viem";
import { hashProjection } from "../src/reconciliation/engine.ts";

const hash = (digit: string): Hex => `0x${digit.repeat(64)}` as Hex;
const snapshot = (): ReconciliationSnapshot => ({
  payoutCredits: [],
  payoutTotals: [],
  claimTotals: [
    { amount: "2", positionId: "2" },
    { amount: "1", positionId: "1" },
  ],
  deep: true,
  marketOpenInterest: [],
  markets: [],
  openOrders: [],
  reservationTotals: [],
  reservations: [],
  resolutions: [],
  state: {
    confirmedBlock: "99",
    finalizedBlock: "90",
    indexedBlock: "100",
    indexedBlockHash: hash("1"),
    indexedBlockTimestamp: "1000",
  },
  walletOpenInterest: [],
});

const report = (
  completedAt: string,
  issues: ReconciliationIssue[] = [],
  deep = true,
): ReconciliationReport => ({
  chainId: 31_337,
  completedAt,
  deep,
  freezeRequired: issues.length > 0,
  freezeScopes: issues.flatMap((entry) => (entry.freezeScope ? [entry.freezeScope] : [])),
  indexedBlock: "100",
  indexedBlockHash: hash("1"),
  issues,
  projectionHash: hash("2"),
  projectionVersion: 3,
  startedAt: completedAt,
  status: issues.length > 0 ? "mismatch" : "ok",
});

describe("projection checkpoints", () => {
  test("are deterministic regardless of database row order", () => {
    const original = snapshot();
    const reversed = { ...original, claimTotals: [...original.claimTotals].reverse() };
    expect(hashProjection(original)).toBe(hashProjection(reversed));
    expect(
      hashProjection({ ...original, state: { ...original.state, indexedBlock: "101" } }),
    ).not.toBe(hashProjection(original));
  });
});

describe("reconciliation freeze signals", () => {
  test("rejects a legacy report before it can change freeze signals", async () => {
    const store = createReconciliationQueries((await testDatabase()).database);
    await expect(
      (async () =>
        await store.record({
          ...report("2026-09-07T00:00:00.000Z"),
          projectionVersion: 1,
        } as unknown as ReconciliationReport))(),
    ).rejects.toThrow("v3");
    expect(await store.latestReport()).toBeNull();
    await store.close();
  });

  test("activate on mismatch and clear after a clean equivalent-depth run", async () => {
    const store = createReconciliationQueries((await testDatabase()).database);
    const mismatch: ReconciliationIssue = {
      actual: "1",
      code: "ROUTER_RESIDUAL_BALANCE",
      details: "unexpected balance",
      expected: "0",
      freezeScope: "global",
      severity: "critical",
    };
    await store.record(report("2026-09-04T00:00:00.000Z", [mismatch]));
    expect(await store.activeSignals()).toHaveLength(1);
    await store.record(report("2026-09-04T00:00:01.000Z"));
    expect(await store.activeSignals()).toHaveLength(0);
    expect((await store.latestReport())?.status).toBe("ok");
    await store.close();
  });

  test("does not clear a deep-only mismatch during a shallow run", async () => {
    const store = createReconciliationQueries((await testDatabase()).database);
    const mismatch: ReconciliationIssue = {
      actual: "different",
      code: "ORDER_STATE_MISMATCH",
      details: "order differs",
      expected: "same",
      freezeScope: `market:${hash("3")}`,
      severity: "critical",
    };
    await store.record(report("2026-09-04T00:00:00.000Z", [mismatch]));
    await store.record(report("2026-09-04T00:00:01.000Z", [], false));
    expect(await store.activeSignals()).toHaveLength(1);
    await store.record(report("2026-09-04T00:00:02.000Z"));
    expect(await store.activeSignals()).toHaveLength(0);
    await store.close();
  });
});
