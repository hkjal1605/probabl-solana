import { describe, expect, test } from "bun:test";
import { INTERNAL_MAINNET_ACK, releasePolicy } from "./release.ts";
import { HttpTradingSafety } from "./safety.ts";

const now = 1_800_000_000_000;
const exchange = `0x${"11".repeat(20)}`;
const blockHash = `0x${"22".repeat(32)}`;
const market = `0x${"33".repeat(32)}`;
function fixture() {
  const report = {
    chainId: 4663,
    completedAt: new Date(now).toISOString(),
    deep: true,
    indexedBlock: "100",
    indexedBlockHash: blockHash,
    projectionVersion: 3,
    status: "ok",
  };
  const head = {
    chainId: 4663,
    exchange,
    healthy: true,
    protocolVersion: 2,
    head: {
      indexedBlock: "101",
      indexedBlockHash: blockHash,
      indexedBlockTimestamp: String(now / 1000),
      confirmedBlock: "99",
      finalizedBlock: "90",
    },
  };
  const control = {
    chainId: 4663,
    exchange,
    latestReport: { ...report },
    latestDeepReport: { ...report },
    signals: [] as Array<{ scope: string }>,
  };
  let canonicalHash = blockHash;
  const request = (async (url: string | URL | Request) =>
    Response.json(
      String(url).includes("/indexer/health")
        ? head
        : String(url).includes("/freeze-signals")
          ? control
          : { hash: canonicalHash },
    )) as typeof fetch;
  const safety = new HttpTradingSafety(
    { ROBINHOOD_CHAIN_ID: "4663", EXCHANGE_ADDRESS: exchange },
    request,
    () => now,
  );
  return {
    head,
    control,
    safety,
    reorg: () => {
      canonicalHash = `0x${"44".repeat(32)}`;
    },
  };
}
describe("fail-closed trading admission", () => {
  test("malformed market freeze scopes deny admission globally", async () => {
    const f = fixture();
    f.control.signals.push({ scope: "market:invalid" });
    await expect(f.safety.assertCanTrade([market])).rejects.toThrow("freeze");
  });
  test("healthy matching deployment can trade", async () => {
    await fixture().safety.assertCanTrade([market]);
  });
  test("market freeze is scoped, global freeze is universal", async () => {
    const f = fixture();
    f.control.signals.push({ scope: `market:${market}` });
    await expect(f.safety.assertCanTrade([market])).rejects.toThrow("freeze");
    await f.safety.assertCanTrade([`0x${"55".repeat(32)}`]);
    f.control.signals = [{ scope: "global" }];
    await expect(f.safety.assertCanTrade([market])).rejects.toThrow("freeze");
  });
  for (const failure of [
    "head-stale",
    "report-stale",
    "deep-stale",
    "wrong-chain",
    "wrong-exchange",
    "unhealthy",
    "future",
    "reorg",
    "missing-signals",
  ] as const) {
    test(`rejects ${failure}`, async () => {
      const f = fixture();
      if (failure === "head-stale") f.head.head.indexedBlockTimestamp = "1";
      if (failure === "report-stale")
        f.control.latestReport.completedAt = new Date(0).toISOString();
      if (failure === "deep-stale")
        f.control.latestDeepReport.completedAt = new Date(0).toISOString();
      if (failure === "wrong-chain") f.control.chainId = 137;
      if (failure === "wrong-exchange") f.head.exchange = `0x${"00".repeat(20)}`;
      if (failure === "unhealthy") f.head.healthy = false;
      if (failure === "future") f.head.head.indexedBlockTimestamp = String(now / 1000 + 60);
      if (failure === "reorg") f.reorg();
      if (failure === "missing-signals") f.control.latestReport.status = "mismatch";
      await expect(f.safety.assertCanTrade([market])).rejects.toThrow();
    });
  }
  test("network failures and malformed responses cannot grant admission", async () => {
    for (const request of [
      async () => {
        throw new Error("offline");
      },
      async () => new Response("{}"),
      async () => new Response("busy", { status: 503 }),
    ]) {
      await expect(
        new HttpTradingSafety(
          { ROBINHOOD_CHAIN_ID: "4663", EXCHANGE_ADDRESS: exchange },
          request as unknown as typeof fetch,
        ).assertCanTrade([market]),
      ).rejects.toThrow();
    }
  });
});
test("experimental deployment is explicit and never production approval", () => {
  expect(() => releasePolicy(4663, {})).toThrow("M-02");
  expect(() => releasePolicy(4663, { DEPLOYMENT_MODE: "internal-mainnet" })).toThrow();
  const accepted = {
    DEPLOYMENT_MODE: "internal-mainnet",
    INTERNAL_MAINNET_RISK_ACK: INTERNAL_MAINNET_ACK,
  };
  expect(releasePolicy(4663, accepted).productionApproved).toBe(false);
  expect(() => releasePolicy(1, accepted)).toThrow();
  expect(releasePolicy(31337, {}).mode).toBe("development");
});
