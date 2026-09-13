import { expect, test } from "bun:test";
import {
  atomicOrderRouterAbi,
  conditionalExchangeAbi,
  conditionalSettlementAbi,
  marketRegistryAbi,
  protocolFeeVaultAbi,
} from "@conditional-stocks/contract-bindings";
import { parseOrder } from "@conditional-stocks/gateway";
import type { AtomicPlan } from "@conditional-stocks/orderbook";
import { type Abi, decodeFunctionData, encodeFunctionResult, type Hex, toHex } from "viem";
import { ViemGatewayChain } from "./chain.ts";
import { loadApiEnvironment } from "./environment.ts";

test("atomic RPC adapter pins rate reads, checks router wiring and simulates exactly as the owner", async () => {
  const address = "0x1000000000000000000000000000000000000001";
  const router = "0x2000000000000000000000000000000000000002";
  const hash = toHex(1, { size: 32 });
  const abi: Abi = [
    ...atomicOrderRouterAbi,
    ...conditionalExchangeAbi,
    ...conditionalSettlementAbi,
    ...marketRegistryAbi,
    ...protocolFeeVaultAbi,
  ];
  let wrong: string | undefined;
  let rejects = false;
  const calls: { method: string; params: unknown[] }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json();
      const answer = (call: { id: number; method: string; params: unknown[] }) => {
        calls.push(call);
        let result: unknown;
        if (call.method === "eth_chainId") result = wrong === "chain" ? "0x1" : "0x7a69";
        else if (call.method === "eth_getBlockByNumber")
          result = { number: "0x64", timestamp: "0x5dc", hash, transactions: [] };
        else {
          expect(call.method).toBe("eth_call");
          const tx = call.params[0] as { data: Hex; to: string; from?: string };
          const decoded = decodeFunctionData({ abi, data: tx.data });
          const name = decoded.functionName;
          const value =
            name === "atomicRouter"
              ? wrong === name
                ? address
                : router
              : name === "EXECUTION_VERSION"
                ? wrong === name
                  ? 1n
                  : 2n
                : name === "PROTOCOL_VERSION"
                  ? wrong === name
                    ? 1
                    : 2
                  : name === "feeRates"
                    ? [100, 200]
                    : name === "nextSequence"
                      ? 0n
                      : name === "placeAndMatchChecked"
                        ? hash
                        : wrong === name
                          ? router
                          : address;
          if (name === "placeAndMatchChecked") {
            expect(tx.from?.toLowerCase()).toBe(address.toLowerCase());
            expect(tx.to.toLowerCase()).toBe(router.toLowerCase());
            expect(call.params[1]).toBe("latest");
            if (rejects)
              return {
                jsonrpc: "2.0",
                id: call.id,
                error: { code: 3, message: "execution reverted", data: "0x" },
              };
          }
          if (["settlement", "feeVault", "feeRates", "nextSequence"].includes(name))
            expect(call.params[1]).toBe("0x64");
          result = encodeFunctionResult({ abi, functionName: name, result: value as never });
        }
        return { jsonrpc: "2.0", id: call.id, result };
      };
      return Response.json(Array.isArray(body) ? body.map(answer) : answer(body));
    },
  });
  const environment = loadApiEnvironment({
    ROBINHOOD_RPC_URL: server.url.href,
    ROBINHOOD_CHAIN_ID: "31337",
    EXCHANGE_ADDRESS: address,
    MARKET_REGISTRY_ADDRESS: address,
    CONDITIONAL_TOKENS_ADDRESS: address,
    POSITION_ROUTER_ADDRESS: address,
    ATOMIC_ORDER_ROUTER_ADDRESS: router,
    PAYOUT_VAULT_ADDRESS: address,
    INDEXER_API_URL: "http://127.0.0.1:42069",
    API_AUTH_DOMAIN: "localhost",
    API_AUTH_ORIGIN: "http://localhost:3000",
    DATABASE_URL: "postgresql://fixture@127.0.0.1:5432/fixture",
  });
  const chain = new ViemGatewayChain(environment);
  const order = parseOrder({
    maker: address,
    recipient: address,
    marketId: hash,
    branch: 0,
    side: 0,
    fundingKind: 0,
    quantity: "1000000000000000000",
    limitPriceRawX18: "100000000",
    expiry: "2000",
    nonce: "0",
    salt: hash,
    tif: 0,
    maxFeeBps: 200,
  });
  const plan: AtomicPlan = {
    guard: { nextSequence: 0n, makerFeeBps: 100, takerFeeBps: 200 },
    releaseOrders: [],
    makers: [],
    quantities: [],
    expectedRemaining: [],
    deadline: 1560n,
    filledQuantity: 0n,
    remainingQuantity: order.quantity,
    executionQuote: 0n,
  };
  try {
    await chain.assertNetwork();
    for (wrong of ["atomicRouter", "EXECUTION_VERSION", "exchange", "PROTOCOL_VERSION", "chain"])
      await expect(chain.assertNetwork()).rejects.toThrow();
    wrong = undefined;
    expect(await chain.executionContext(order)).toEqual({
      timestamp: 1500n,
      blockNumber: 100n,
      makerFeeBps: 100,
      takerFeeBps: 200,
      nextSequence: 0n,
    });
    const data = chain.atomicCalldata(order, "0x12", plan);
    expect(decodeFunctionData({ abi: atomicOrderRouterAbi, data })).toMatchObject({
      functionName: "placeAndMatchChecked",
      args: [order, "0x12", [], [], [], 1560n, plan.guard, []],
    });
    await chain.simulateAtomic(order, "0x12", plan);
    rejects = true;
    await expect(chain.simulateAtomic(order, "0x12", plan)).rejects.toThrow();
    expect(
      calls.every(
        (call) => !call.method.startsWith("eth_send") && !call.method.startsWith("eth_sign"),
      ),
    ).toBe(true);
  } finally {
    await server.stop(true);
  }
});
