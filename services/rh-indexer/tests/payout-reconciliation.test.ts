import { expect, test } from "bun:test";
import {
  conditionalExchangeAbi,
  conditionalTokensAbi,
  payoutVaultAbi,
} from "@conditional-stocks/contract-bindings";
import type { ReconciliationSnapshot } from "@conditional-stocks/db/reconciliation/types";
import {
  type Abi,
  type Address,
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  type Hex,
  toHex,
} from "viem";
import { loadIndexerEnvironment } from "../src/environment.ts";
import { hashProjection, runReconciliation } from "../src/reconciliation/engine.ts";

test("vault reconciliation checks missing events, exact beneficiaries and backing without donation-triggered freezes", async () => {
  const address = (n: number) => toHex(n, { size: 20 });
  const base = address(1),
    quote = address(2),
    exchange = address(3),
    settlement = address(4),
    ctf = address(5),
    vault = address(6),
    router = address(7),
    owner = address(8);
  const abi: Abi = [
    ...erc20Abi,
    ...conditionalTokensAbi,
    ...conditionalExchangeAbi,
    ...payoutVaultAbi,
  ];
  const balances = new Map<string, bigint>();
  const set = (asset: Address, holder: Address, id: bigint | undefined, amount: bigint) =>
    balances.set(`${asset}:${holder}:${id ?? "whole"}`, amount);
  let liability = 1n,
    ownerCredit = 1n;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json();
      const answer = (call: { id: number; params: [{ to: Address; data: Hex }, string] }) => {
        expect(call.params[1]).toBe("0x64");
        const tx = call.params[0];
        const decoded = decodeFunctionData({ abi, data: tx.data });
        const args = decoded.args as unknown[] | undefined;
        let value = 0n;
        if (decoded.functionName === "decimals") value = 18n;
        if (decoded.functionName === "balanceOf")
          value = balances.get(`${tx.to}:${args?.[0]}:${args?.[1] ?? "whole"}`) ?? 0n;
        if (decoded.functionName === "totalClaimable" && args?.[0] === ctf && args?.[1] === 1n)
          value = liability;
        if (decoded.functionName === "claimable") value = ownerCredit;
        return {
          jsonrpc: "2.0",
          id: call.id,
          result: encodeFunctionResult({ abi, functionName: decoded.functionName, result: value }),
        };
      };
      return Response.json(Array.isArray(body) ? body.map(answer) : answer(body));
    },
  });
  const env = loadIndexerEnvironment({
    ROBINHOOD_CHAIN_ID: "31337",
    ROBINHOOD_RPC_URL: server.url.href,
    DEPLOYMENT_BLOCK: "0",
    CONDITIONAL_TOKENS_ADDRESS: ctf,
    EXCHANGE_ADDRESS: exchange,
    PAYOUT_VAULT_ADDRESS: vault,
    SETTLEMENT_ADDRESS: settlement,
    POSITION_ROUTER_ADDRESS: router,
    MARKET_REGISTRY_ADDRESS: address(9),
    PROTOCOL_AUTHORITY_ADDRESS: address(10),
    RESOLUTION_CONTROLLER_ADDRESS: address(11),
    ORDER_RECOVERY_ROUTER_ADDRESS: address(12),
  });
  const snapshot: ReconciliationSnapshot = {
    state: {
      confirmedBlock: "100",
      indexedBlock: "100",
      indexedBlockHash: toHex(1, { size: 32 }),
      indexedBlockTimestamp: "1000",
      finalizedBlock: "99",
    },
    deep: true,
    openOrders: [],
    reservations: [],
    reservationTotals: [],
    marketOpenInterest: [],
    walletOpenInterest: [],
    resolutions: [],
    markets: [
      {
        id: toHex(1, { size: 32 }),
        conditionId: toHex(2, { size: 32 }),
        baseToken: base,
        quoteToken: quote,
        baseTokenDecimals: 18,
        quoteTokenDecimals: 18,
        protocolVersion: 2,
        priceFormat: "raw-unit-ratio-x18",
        state: 2,
        stockYesPositionId: "1",
        stockNoPositionId: "2",
        quoteYesPositionId: "3",
        quoteNoPositionId: "4",
      },
    ],
    claimTotals: [
      { positionId: "1", amount: "1" },
      { positionId: "2", amount: "1" },
    ],
    payoutCredits: [{ beneficiary: owner, asset: ctf, tokenId: "1", amount: "1" }],
    payoutTotals: [{ asset: ctf, tokenId: "1", amount: "1" }],
  };
  const run = (value = snapshot) =>
    runReconciliation(value, env, { deep: true, exclusiveConditionalTokens: true });
  set(base, ctf, undefined, 1n);
  set(ctf, vault, 1n, 1n);
  try {
    expect((await run()).issues).toEqual([]);
    expect(hashProjection(snapshot)).not.toBe(hashProjection({ ...snapshot, payoutCredits: [] }));
    // Donations to all whole-collateral holding contracts cannot freeze trading.
    for (const holder of [exchange, settlement, router, ctf, vault])
      set(base, holder, undefined, 2n);
    const donation = await run();
    expect(donation.freezeRequired).toBe(false);
    expect(donation.issues.map((x) => x.code).sort()).toEqual(
      [
        "CTF_COLLATERAL_SURPLUS",
        "EXCHANGE_COLLATERAL_DONATION",
        "ROUTER_COLLATERAL_DONATION",
        "ROUTER_COLLATERAL_DONATION",
      ].sort(),
    );
    expect(
      (await run({ ...snapshot, payoutCredits: [], payoutTotals: [] })).issues.some(
        (x) => x.code === "PAYOUT_LIABILITY_MISMATCH",
      ),
    ).toBe(true);
    ownerCredit = 0n;
    expect((await run()).issues.some((x) => x.code === "PAYOUT_BENEFICIARY_MISMATCH")).toBe(true);
    ownerCredit = 1n;
    set(ctf, vault, 1n, 0n);
    expect((await run()).freezeScopes).toContain("global");
    set(ctf, vault, 1n, 2n);
    expect((await run()).issues.some((x) => x.code === "PAYOUT_BACKING_MISMATCH")).toBe(true);
    set(ctf, vault, 1n, 1n);
    liability = 0n;
    expect((await run()).issues.some((x) => x.code === "PAYOUT_LIABILITY_MISMATCH")).toBe(true);
    liability = 1n;
    set(base, ctf, undefined, 0n);
    expect(
      (await run()).issues.some(
        (x) => x.code === "CTF_COLLATERAL_LIABILITY_MISMATCH" && x.severity === "critical",
      ),
    ).toBe(true);
  } finally {
    await server.stop(true);
  }
});
