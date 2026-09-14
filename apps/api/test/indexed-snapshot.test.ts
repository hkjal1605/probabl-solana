import { expect, test } from "bun:test";
import { bn, coder, PublicKey, SolanaClient } from "@conditional-stocks/solana-client";
import { indexedSnapshot } from "../src/indexed-snapshot";

test("API planning decodes a healthy persisted snapshot without any RPC", async () => {
  const config = PublicKey.unique(), owner = PublicKey.unique();
  const client = new SolanaClient({ rpcUrl: "http://127.0.0.1:1", config: String(config), genesisHash: "test" });
  const data = await coder.accounts.encode("Config", { seed_authority: owner, admin: owner, quote_mint: owner,
    roles: { market_admin: owner, guardian: owner, resolution_admin: owner }, paused: false,
    maker_bps: 0, taker_bps: 0, pending_admin: owner, admin_after: bn(0), bump: 0 });
  let calls = 0;
  const db = { query: async (sql: string, values: unknown[]) => {
    calls++;
    expect(sql).toContain("interval '15 seconds'");
    expect(sql).toContain("accounts->>'healthy'='true'");
    expect(values).toEqual(["domain"]);
    return { rows: [{ slot: "123", observed_at_ms: String(Date.now()), accounts: {
      rawAccounts: [{ address: String(config), data: data.toString("base64") }],
    } }] };
  } };
  const result = await indexedSnapshot(db as any, client, "domain");
  expect(result.slot).toBe(123);
  expect(result.config.admin.equals(owner)).toBe(true);
  expect(calls).toBe(1);
});
test("missing or pre-migration snapshots fail closed without RPC fallback", async () => {
  const client = new SolanaClient({ rpcUrl: "http://127.0.0.1:1", config: String(PublicKey.unique()), genesisHash: "test" });
  for (const rows of [[], [{ accounts: {} }]])
    await expect(indexedSnapshot({ query: async () => ({ rows }) } as any, client, "test")).rejects.toThrow("snapshot unavailable");
});
