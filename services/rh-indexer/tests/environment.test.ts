import { describe, expect, test } from "bun:test";

import { loadIndexerEnvironment } from "../src/environment.ts";

const baseEnvironment = (): NodeJS.ProcessEnv => ({
  CONDITIONAL_TOKENS_ADDRESS: "0x0000000000000000000000000000000000000001",
  DEPLOYMENT_BLOCK: "100",
  EXCHANGE_ADDRESS: "0x0000000000000000000000000000000000000002",
  INDEXER_CONFIRMATION_BLOCKS: "2",
  INDEXER_FINALITY_BLOCKS: "30",
  MARKET_REGISTRY_ADDRESS: "0x0000000000000000000000000000000000000003",
  ORDER_RECOVERY_ROUTER_ADDRESS: "0x0000000000000000000000000000000000000004",
  POSITION_ROUTER_ADDRESS: "0x0000000000000000000000000000000000000005",
  PROTOCOL_AUTHORITY_ADDRESS: "0x0000000000000000000000000000000000000006",
  RESOLUTION_CONTROLLER_ADDRESS: "0x0000000000000000000000000000000000000007",
  ROBINHOOD_CHAIN_ID: "46630",
  ROBINHOOD_RPC_URL: "https://rpc-1.example, https://rpc-2.example",
  SETTLEMENT_ADDRESS: "0x0000000000000000000000000000000000000008",
  PAYOUT_VAULT_ADDRESS: "0x0000000000000000000000000000000000000009",
});

describe("indexer environment", () => {
  test("parses validated RPC failover and confirmation settings", () => {
    const result = loadIndexerEnvironment(baseEnvironment());
    expect(result.chainId).toBe(46_630);
    expect(result.deploymentBlock).toBe(100);
    expect(result.confirmationBlockCount).toBe(2n);
    expect(result.finalityBlockCount).toBe(30n);
    expect(result.rpcUrls).toEqual(["https://rpc-1.example", "https://rpc-2.example"]);
    expect(result.blockRetention).toBe(8192);
    expect(result.cacheRetention).toBe(8192);
  });

  test("rejects zero addresses, unsafe ranges, and invalid confirmation policy", () => {
    for (const key of [
      "INDEXER_BLOCK_RETENTION",
      "INDEXER_CACHE_RETENTION",
      "INDEXER_CACHE_MAINTENANCE_INTERVAL_MS",
      "INDEXER_CACHE_MAINTENANCE_BATCH_SIZE",
    ])
      expect(() => loadIndexerEnvironment({ ...baseEnvironment(), [key]: "0" })).toThrow();
    expect(() =>
      loadIndexerEnvironment({ ...baseEnvironment(), INDEXER_BLOCK_RETENTION: "2" }),
    ).toThrow("exceed confirmation");
    expect(() =>
      loadIndexerEnvironment({
        ...baseEnvironment(),
        INDEXER_CACHE_MAINTENANCE_BATCH_SIZE: "10001",
      }),
    ).toThrow("10000");
    expect(() =>
      loadIndexerEnvironment({
        ...baseEnvironment(),
        EXCHANGE_ADDRESS: "0x0000000000000000000000000000000000000000",
      }),
    ).toThrow("EXCHANGE_ADDRESS");
    expect(() =>
      loadIndexerEnvironment({ ...baseEnvironment(), INDEXER_GET_LOGS_BLOCK_RANGE: "0" }),
    ).toThrow("positive safe integer");
    expect(() => loadIndexerEnvironment({ ...baseEnvironment(), INDEXER_END_BLOCK: "99" })).toThrow(
      "INDEXER_END_BLOCK",
    );
    expect(() =>
      loadIndexerEnvironment({
        ...baseEnvironment(),
        INDEXER_CONFIRMATION_BLOCKS: "31",
        INDEXER_FINALITY_BLOCKS: "30",
      }),
    ).toThrow("confirmation blocks");
  });
});
