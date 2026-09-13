import { expect, test } from "bun:test";
import {
  manualResolutionControllerAbi,
  marketRegistryAbi,
} from "@conditional-stocks/contract-bindings";
import {
  type Abi,
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  type Hex,
  keccak256,
  parseAbi,
  toHex,
} from "viem";
import {
  adminFixture,
  controllerFixture,
  creationFixture,
  otherFixture,
  registryFixture,
  resolutionFixture,
} from "../../../packages/market-data/tests/admin-fixtures";
import { AdminEvidenceChain } from "./admin-chain";
import { loadApiEnvironment } from "./environment";

test("admin chain preflights use MARKET_ADMIN for every action and reject missing or revoked roles", async () => {
  const roleAbi = parseAbi(["function hasRole(bytes32,address) view returns (bool)"]);
  const abi: Abi = [
    ...marketRegistryAbi,
    ...manualResolutionControllerAbi,
    ...erc20Abi,
    ...roleAbi,
  ];
  const calls: { name: string; from?: string; args?: readonly unknown[] }[] = [];
  let marketRole = true,
    resolutionRole = false,
    wrongChain = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const input = await request.json();
      const answer = (call: { id: number; method: string; params: unknown[] }) => {
        let result: unknown;
        if (call.method === "eth_chainId") result = wrongChain ? "0x1" : "0x7a69";
        else if (call.method === "eth_getBlockByNumber")
          result = {
            number: "0x64",
            timestamp: "0x6b49d200",
            hash: toHex(1, { size: 32 }),
            transactions: [],
          };
        else {
          expect(call.method).toBe("eth_call");
          const tx = call.params[0] as { data: Hex; from?: string };
          const decoded = decodeFunctionData({ abi, data: tx.data });
          calls.push({
            name: decoded.functionName,
            ...(tx.from ? { from: tx.from } : {}),
            ...(decoded.args ? { args: decoded.args } : {}),
          });
          const value =
            decoded.functionName === "PROTOCOL_VERSION"
              ? 2
              : decoded.functionName === "authority"
                ? otherFixture
                : decoded.functionName === "hasRole"
                  ? decoded.args?.[0] === keccak256(toHex("MARKET_ADMIN_ROLE"))
                    ? marketRole
                    : resolutionRole
                  : decoded.functionName === "decimals"
                    ? 6
                    : decoded.functionName === "computeMarketId" ||
                        decoded.functionName === "createMarket"
                      ? toHex(2, { size: 32 })
                      : undefined;
          result = encodeFunctionResult({ abi, functionName: decoded.functionName, result: value });
        }
        return { id: call.id, jsonrpc: "2.0", result };
      };
      return Response.json(Array.isArray(input) ? input.map(answer) : answer(input));
    },
  });
  try {
    const environment = loadApiEnvironment({
      ROBINHOOD_CHAIN_ID: "31337",
      ROBINHOOD_RPC_URL: `http://127.0.0.1:${server.port}`,
      CONDITIONAL_TOKENS_ADDRESS: otherFixture,
      EXCHANGE_ADDRESS: otherFixture,
      ATOMIC_ORDER_ROUTER_ADDRESS: otherFixture,
      PAYOUT_VAULT_ADDRESS: otherFixture,
      MARKET_REGISTRY_ADDRESS: registryFixture,
      POSITION_ROUTER_ADDRESS: otherFixture,
    });
    const chain = new AdminEvidenceChain(environment, {
      marketAdmin: adminFixture,
      resolutionController: controllerFixture,
      attachmentPublicBaseUrl: "https://evidence.example.test",
      polymarketIngestorUrl: "http://127.0.0.1:1",
      polymarketIngestorToken: "test-only-token",
    });
    await chain.assertNetwork();
    const creation = await chain.creationPreview(creationFixture());
    const begin = await chain.beginResolutionPreview(resolutionFixture());
    for (const result of [creation, begin]) expect(result.from).toBe(adminFixture);
    await expect(chain.resolutionPreview(resolutionFixture())).rejects.toThrow(
      "RESOLUTION_ADMIN_ROLE",
    );
    expect(calls.some((call) => call.name === "resolveMarket")).toBe(false);
    resolutionRole = true;
    expect((await chain.resolutionPreview(resolutionFixture())).from).toBe(adminFixture);
    for (const call of calls.filter((call) =>
      ["createMarket", "beginResolution", "resolveMarket"].includes(call.name),
    ))
      expect(call.from?.toLowerCase()).toBe(adminFixture.toLowerCase());
    resolutionRole = false;
    await expect(chain.resolutionPreview(resolutionFixture())).rejects.toThrow(
      "RESOLUTION_ADMIN_ROLE",
    );
    marketRole = false;
    await expect(chain.assertNetwork()).rejects.toThrow("MARKET_ADMIN_ROLE");
    await expect(chain.creationPreview(creationFixture())).rejects.toThrow("MARKET_ADMIN_ROLE");
    await expect(chain.beginResolutionPreview(resolutionFixture())).rejects.toThrow(
      "MARKET_ADMIN_ROLE",
    );
    wrongChain = true;
    await expect(chain.assertNetwork()).rejects.toThrow("chain mismatch");
  } finally {
    await server.stop(true);
  }
});
