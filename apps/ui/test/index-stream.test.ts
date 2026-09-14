import { afterEach, expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { parseIndexUpdate, parseStreamWallet, setIndexStreamHealthy } from "../src/lib/api/index-stream";
import { readPollInterval } from "../src/lib/api/read-policy";
afterEach(() => setIndexStreamHealthy(0));
const owner = PublicKey.unique().toBase58();
test("healthy SSE disables only covered queries; failure restores polling", () => {
  const query = (kind: string) => ({ queryKey: [kind], state: { status: "success", fetchFailureCount: 0 } });
  setIndexStreamHealthy(Date.now() + 10_000);
  for (const kind of ["markets", "wallet-orders", "trades", "positions", "whole-balances", "trading-readiness"])
    expect(readPollInterval(query(kind))).toBe(false);
  expect(readPollInterval(query("unrelated"))).toBe(10_000);
  setIndexStreamHealthy(0);
  expect(readPollInterval(query("markets"))).toBe(10_000);
});
test("stream validation rejects stale state, malformed topics and forged readiness", () => {
  const valid = { slot: 1, observedAt: Date.now(), markets: [owner], owners: [] };
  expect(parseIndexUpdate(JSON.stringify(valid)).slot).toBe(1);
  for (const change of [{ slot: -1 }, { observedAt: Date.now() - 16_000 }, { markets: ["bad"] },
    { readiness: { [owner]: { reason: "closed", healthy: true, checkedAt: Date.now() } } }])
    expect(() => parseIndexUpdate(JSON.stringify({ ...valid, ...change }))).toThrow();
});
test("wallet stream cannot substitute identity, malformed amounts or expired data", () => {
  const valid = { owner, observedAt: Date.now(), blockNumber: "12", positions: [], balances: {} };
  expect(parseStreamWallet(valid, owner)).toEqual(valid);
  for (const change of [{ owner: "other" }, { observedAt: Date.now() - 31_000 },
    { balances: { [owner]: { account: owner, token: owner, decimals: 6, canonicalBalance: "-1", blockNumber: "12", creditBalances: {} } } }])
    expect(() => parseStreamWallet({ ...valid, ...change }, owner)).toThrow();
});
