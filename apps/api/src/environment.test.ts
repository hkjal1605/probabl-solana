import { expect, test } from "bun:test";
import { loadAdminEvidenceEnvironment } from "./admin-environment.ts";
import { loadApiEnvironment } from "./environment.ts";

const maker = "0x1000000000000000000000000000000000000001";
const other = "0x2000000000000000000000000000000000000002";
const api = {
  ROBINHOOD_CHAIN_ID: "31337",
  CONDITIONAL_TOKENS_ADDRESS: maker,
  EXCHANGE_ADDRESS: maker,
  ATOMIC_ORDER_ROUTER_ADDRESS: maker,
  PAYOUT_VAULT_ADDRESS: maker,
  MARKET_REGISTRY_ADDRESS: maker,
  POSITION_ROUTER_ADDRESS: maker,
  ROBINHOOD_RPC_URL: "http://127.0.0.1:8545",
};

test("API configuration validates atomic identity without a trading signer or wallet allowlist", () => {
  const result = loadApiEnvironment(api);
  expect(result.chainId).toBe(31337);
  expect(result.atomicRouter).toBe(maker);
  expect(result).not.toHaveProperty("relayerPrivateKey");
  expect(result.authOrigin).toBe("http://127.0.0.1:3000");
  for (const field of Object.keys(api))
    expect(() => loadApiEnvironment({ ...api, [field]: "" })).toThrow();
  for (const chain of ["-1", "1.5", "0", "Infinity", "9007199254740992"])
    expect(() => loadApiEnvironment({ ...api, ROBINHOOD_CHAIN_ID: chain })).toThrow();
  for (const field of ["API_AUTH_ORIGIN", "INDEXER_URL"])
    expect(() => loadApiEnvironment({ ...api, [field]: "file:///bad" })).toThrow("HTTP(S)");
  expect(loadApiEnvironment({ ...api, ROBINHOOD_CHAIN_ID: "4663" }).chainId).toBe(4663);
  const production = loadApiEnvironment({
    ...api,
    ROBINHOOD_CHAIN_ID: "4663",
    API_AUTH_ORIGIN: "https://probabl.test",
    API_AUTH_DOMAIN: "probabl.test",
    INDEXER_URL: "https://indexer.probabl.test",
  });
  expect(production.chainId).toBe(4663);
  expect(production.authDomain).toBe("probabl.test");
});

test("obsolete tester configuration cannot restrict trading or prevent mainnet API startup", () => {
  const mainnet = { ...api, ROBINHOOD_CHAIN_ID: "4663" };
  for (const legacyValue of ["", maker, `${maker},${other}`, "not-an-address"]) {
    expect(loadApiEnvironment({ ...mainnet, INTERNAL_TESTER_ADDRESSES: legacyValue })).toEqual(
      loadApiEnvironment(mainnet),
    );
  }
});

test("admin evidence uses only MARKET_ADMIN and requires public HTTPS downloads", () => {
  expect(loadAdminEvidenceEnvironment({})).toBeNull();
  const base = {
    MARKET_ADMIN: maker,
    POLYMARKET_INTERNAL_TOKEN: "local-fixture-token",
    ADMIN_EVIDENCE_PUBLIC_BASE_URL: "https://api.probabl.test/v1/attachments/",
    RESOLUTION_CONTROLLER_ADDRESS: maker,
  };
  const result = loadAdminEvidenceEnvironment(base);
  expect(result?.marketAdmin).toBe(maker);
  expect(result).not.toHaveProperty("operators");
  expect(result).not.toHaveProperty("resolutionAdminSafe");
  expect(
    loadAdminEvidenceEnvironment({
      ADMIN_OPERATOR_ADDRESSES: other,
      MARKET_ADMIN_SAFE_ADDRESS: other,
    }),
  ).toBeNull();
  expect(
    loadAdminEvidenceEnvironment({
      ...base,
      ADMIN_OPERATOR_ADDRESSES: other,
      MARKET_ADMIN_SAFE_ADDRESS: other,
      RESOLUTION_ADMIN_SAFE_ADDRESS: other,
    }),
  ).toEqual(result);
  expect(loadAdminEvidenceEnvironment({ ...base, MARKET_ADMIN: "" })).toBeNull();
  expect(result?.attachmentPublicBaseUrl).toBe("https://api.probabl.test/v1/attachments");
  for (const overrides of [
    { MARKET_ADMIN: "bad" },
    { MARKET_ADMIN: "0x0000000000000000000000000000000000000000" },
    { MARKET_ADMIN: `${maker},${other}` },
    { POLYMARKET_INTERNAL_TOKEN: "short" },
    { POLYMARKET_INGESTOR_URL: "file:///bad" },
    { ADMIN_EVIDENCE_PUBLIC_BASE_URL: "http://api.probabl.test" },
    { ADMIN_EVIDENCE_PUBLIC_BASE_URL: "" },
    { RESOLUTION_CONTROLLER_ADDRESS: "bad" },
  ])
    expect(() => loadAdminEvidenceEnvironment({ ...base, ...overrides })).toThrow();
  expect(
    loadAdminEvidenceEnvironment({ ...base, POLYMARKET_INGESTOR_URL: "https://feed.probabl.test/" })
      ?.polymarketIngestorUrl,
  ).toBe("https://feed.probabl.test");
});
