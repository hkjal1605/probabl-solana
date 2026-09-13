import { expect, test } from "bun:test";
import { createGatewayQueries } from "@conditional-stocks/db/gateway";
import { testDatabase } from "@conditional-stocks/db/testing";
import { Branch, FundingKind, hashOrder, Side, TimeInForce } from "@conditional-stocks/domain";
import {
  GatewayError,
  GatewayErrorCode,
  parseOrder,
  type ValidationSnapshot,
} from "@conditional-stocks/gateway";
import { type Address, type Hex, keccak256 } from "viem";
import { createApp } from "./app.ts";
import {
  type CanonicalMarket,
  type CanonicalOrder,
  type CanonicalResolution,
  type CanonicalTransaction,
  IndexerClient,
  ViemGatewayChain,
} from "./chain.ts";
import type { ApiEnvironment } from "./environment.ts";
import { GatewayService } from "./service.ts";

const maker: Address = "0x1000000000000000000000000000000000000001";
const other: Address = "0x2000000000000000000000000000000000000002";
const hash: Hex = `0x${"11".repeat(32)}`;
const env: ApiEnvironment = {
  authDomain: "probabl.test",
  authOrigin: "https://probabl.test",
  chainId: 31337,
  conditionalTokens: other,
  exchange: maker,
  indexerUrl: "http://127.0.0.1:1",
  atomicRouter: other,
  payoutVault: other,
  marketRegistry: other,
  positionRouter: other,
  rpcUrl: "http://127.0.0.1:1",
};
const wire = {
  branch: Branch.Yes,
  expiry: "1900",
  fundingKind: FundingKind.WholeCollateral,
  limitPriceRawX18: "200000000",
  maker,
  marketId: hash,
  nonce: "7",
  quantity: "1000000000000000000",
  recipient: maker,
  salt: hash,
  side: Side.Buy,
  tif: TimeInForce.Gtc,
  maxFeeBps: 0,
};
const snapshot: ValidationSnapshot = {
  chainId: 31337n,
  safeBlockNumber: 100n,
  safeBlockHash: hash,
  safeBlockTimestamp: 1500n,
  tradingPaused: false,
  minimumNonce: 7n,
  nextSequence: 10n,
  marketOpenNotional: 0n,
  walletOpenNotional: 0n,
  market: {
    baseTokenDecimals: 18,
    quoteTokenDecimals: 6,
    protocolVersion: 2,
    priceFormat: "raw-unit-ratio-x18",
    baseStep: 10n ** 15n,
    baseToken: maker,
    quoteToken: other,
    conditionId: hash,
    conditionalTokens: other,
    maxMarketOpenNotional: 10_000_000_000n,
    maxOrderNotional: 1_000_000_000n,
    maxOrderQuantity: 10n ** 19n,
    maxWalletOpenNotional: 2_000_000_000n,
    minNotional: 10_000n,
    priceTickRawX18: 10_000n,
    quoteNoPositionId: 2n,
    quoteYesPositionId: 1n,
    stockNoPositionId: 4n,
    stockYesPositionId: 3n,
    state: 2,
    tradingCutoff: 2000n,
    tradingOpen: 1000n,
  },
};
class Chain extends ViemGatewayChain {
  authValid = true;
  signatureValid = true;
  balance = 10n ** 25n;
  allowance = 10n ** 25n;
  approved = true;
  simulationError = false;
  broadcastError = false;
  snapshotError = false;
  snapshotValue = structuredClone(snapshot);
  onSnapshot: (() => Promise<void>) | null = null;
  broadcasts: Hex[] = [];
  receiptValue: Awaited<ReturnType<ViemGatewayChain["receipt"]>> = null;
  constructor(environment: ApiEnvironment = env) {
    super(environment);
    this.snapshotValue.chainId = BigInt(environment.chainId);
  }
  override async snapshot() {
    await this.onSnapshot?.();
    if (this.snapshotError) throw new Error("private database details");
    return structuredClone(this.snapshotValue);
  }
  override async funding() {
    return { allowance: this.allowance, approvedForAll: this.approved, balance: this.balance };
  }
  override async verifyAuthMessage() {
    return this.authValid;
  }
  override async verifyOrderSignature() {
    return this.signatureValid;
  }
  executionTime = 1500n;
  executionSequence = 10n;
  makerFeeBps = 0;
  takerFeeBps = 0;
  credit = 10n;
  simulated = 0;
  override async executionContext() {
    return {
      timestamp: this.executionTime,
      blockNumber: 101n,
      makerFeeBps: this.makerFeeBps,
      takerFeeBps: this.takerFeeBps,
      nextSequence: this.executionSequence,
    };
  }
  override async simulateAtomic() {
    this.simulated++;
    if (this.simulationError) throw new Error("simulation revert");
  }
  override async broadcast(raw: Hex) {
    if (this.broadcastError) throw new Error("RPC disconnected");
    this.broadcasts.push(raw);
    return keccak256(raw);
  }
  override async receipt() {
    return this.receiptValue;
  }
  override async validateRawTransaction(raw: Hex) {
    return { nonce: 12n, transactionHash: keccak256(raw) };
  }
  override async positionRouterApproved() {
    return this.approved;
  }
  override async simulateUserCall() {
    if (this.simulationError) throw new Error("simulated revert");
  }
  override async payoutCredit(_beneficiary: Address) {
    return this.credit;
  }
}
class Indexer extends IndexerClient {
  candidates: import("@conditional-stocks/orderbook").MatchCandidate[] = [];
  stale: import("@conditional-stocks/orderbook").StaleReservation[] = [];
  override async staleReservations() {
    return this.stale;
  }
  override async matchCandidates() {
    return this.candidates;
  }
  orderValue: CanonicalOrder | null = null;
  transactionValue: CanonicalTransaction | null = null;
  marketValue: CanonicalMarket | null = {
    ...snapshot.market,
    baseStep: "1000000000000000",
    maxMarketOpenNotional: "10000000000",
    maxOrderNotional: "1000000000",
    maxOrderQuantity: "10000000000000000000",
    maxWalletOpenNotional: "2000000000",
    minNotional: "10000",
    priceTickRawX18: "10000",
    tradingCutoff: "2000",
    tradingOpen: "1000",
    id: hash,
    metadataHash: hash,
    polymarketConditionId: hash,
    polymarketNoIndex: "1",
    polymarketYesIndex: "0",
    rulesHash: hash,
    stateReasonHash: hash,
  };
  resolutionValue: CanonicalResolution | null = {
    admin: maker,
    evidenceHash: hash,
    evidenceUri: "https://probabl.test/evidence",
    noPayout: "1",
    yesPayout: "1",
    payoutDenominator: "2",
    transactionHash: hash,
  };
  constructor() {
    super(env.indexerUrl);
  }
  override async order() {
    return this.orderValue;
  }
  override async transaction() {
    return this.transactionValue;
  }
  override async market() {
    return this.marketValue;
  }
  override async resolution() {
    return this.resolutionValue;
  }
}
async function setup(environment: ApiEnvironment = env) {
  const fixture = await testDatabase();
  const chain = new Chain(environment);
  const indexer = new Indexer();
  const store = createGatewayQueries(fixture.database);
  const service = new GatewayService(environment, store, chain, indexer);
  return { fixture, chain, indexer, store, service };
}

test("checked quotes reject unconfirmed admissions, changed eligibility, omitted best makers and cap corruption", async () => {
  const { service, indexer, chain } = await setup();
  const mk = (sequence: number, price: string) => {
    const order = parseOrder({
      ...wire,
      maker: other,
      recipient: other,
      side: 1,
      salt: `0x${String(sequence).repeat(64)}`,
      limitPriceRawX18: price,
    });
    return {
      order,
      orderHash: hashOrder(order, { chainId: 31337n, verifyingContract: env.exchange }),
      sequence: BigInt(sequence),
      remaining: order.quantity,
    };
  };
  indexer.candidates = [mk(1, "199000000"), mk(2, "200000000")];
  const best = indexer.candidates[0];
  const worse = indexer.candidates[1];
  if (!best || !worse) throw new Error("Missing candidate fixtures");
  chain.snapshotValue.marketOpenNotional = 399_000_000n;
  const quote = await service.prepareOrder({ order: wire }, maker);
  const tx = () => wireJson({ order: wire, plan: quote.plan, signature: "0x12" });
  chain.executionSequence++;
  await expect(service.orderTransaction(tx(), maker)).rejects.toMatchObject({ status: 503 });
  chain.executionSequence--;
  chain.makerFeeBps = 1;
  await expect(service.orderTransaction(tx(), maker)).rejects.toBeInstanceOf(GatewayError);
  chain.makerFeeBps = 0;
  for (const changes of [
    { makers: [], quantities: [], expectedRemaining: [] },
    { makers: [worse.order] },
    { releaseOrders: [hash] },
    { expectedRemaining: [BigInt(wire.quantity) - 1n] },
  ])
    await expect(
      service.orderTransaction(wireJson({ ...tx(), plan: { ...quote.plan, ...changes } }), maker),
    ).rejects.toBeInstanceOf(GatewayError);
  // Another user consumes the maker while the reviewed quote is outstanding.
  best.remaining /= 2n;
  await expect(service.orderTransaction(tx(), maker)).rejects.toMatchObject({ status: 409 });
  expect(chain.simulated).toBe(0);
  expect(chain.broadcasts).toEqual([]);
});

test("API recovers only necessary stale escrow and never rejects reducing execution at gross caps", async () => {
  const { service, indexer, chain } = await setup();
  chain.snapshotValue.marketOpenNotional = snapshot.market.maxMarketOpenNotional;
  chain.snapshotValue.walletOpenNotional = snapshot.market.maxWalletOpenNotional;
  indexer.stale = [{ orderHash: hash, marketId: hash, maker, openNotional: 200_000_000n }];
  expect((await service.prepareOrder({ order: wire }, maker)).plan.releaseOrders).toEqual([hash]);
  indexer.stale = [];
  await expect(service.prepareOrder({ order: wire }, maker)).rejects.toMatchObject({ status: 409 });
  const order = parseOrder({ ...wire, side: 1, maker: other, recipient: other });
  indexer.candidates = [
    {
      order,
      orderHash: hashOrder(order, { chainId: 31337n, verifyingContract: env.exchange }),
      sequence: 1n,
      remaining: order.quantity,
    },
  ];
  const plan = (await service.prepareOrder({ order: wire }, maker)).plan;
  expect(plan.remainingQuantity).toBe(0n);
  expect(plan.releaseOrders).toEqual([]);
});

test("payout and stale recovery remain user-paid during freezes; input spoofing cannot spend another beneficiary", async () => {
  const { chain, indexer, store } = await setup();
  const service = new GatewayService(env, store, chain, indexer, {
    assertCanTrade: async () => {
      throw new Error("frozen");
    },
  });
  let owner: Address | undefined;
  chain.payoutCredit = async (beneficiary: Address) => {
    owner = beneficiary;
    return chain.credit;
  };
  const input = {
    asset: env.conditionalTokens,
    tokenId: "1",
    amount: "4",
    recipient: maker,
    beneficiary: other,
  };
  const result = await service.preparePayoutWithdrawal(input, maker);
  expect(owner).toBe(maker);
  expect(result.transaction).toMatchObject({ from: maker, to: env.payoutVault, value: 0n });
  for (const patch of [
    { amount: "0" },
    { amount: "11" },
    { amount: "01" },
    { amount: String(1n << 256n) },
    { tokenId: "-1" },
    { recipient: env.payoutVault },
    { asset: maker },
  ])
    await expect(
      service.preparePayoutWithdrawal({ ...input, ...patch }, maker),
    ).rejects.toBeInstanceOf(GatewayError);
  chain.credit = 0n;
  await expect(service.preparePayoutWithdrawal(input, maker)).rejects.toMatchObject({
    status: 409,
  });
  chain.credit = 10n;
  chain.simulationError = true;
  await expect(service.preparePayoutWithdrawal(input, maker)).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    service.prepareOrderRecovery({ kind: "expired", orderHash: hash }, other),
  ).rejects.toMatchObject({ status: 409 });
  chain.simulationError = false;
  for (const kind of ["expired", "invalidated", "closed"])
    expect(
      (await service.prepareOrderRecovery({ kind, orderHash: hash }, other)).transaction.from,
    ).toBe(other);
  await expect(
    service.prepareOrderRecovery({ kind: "cancel", orderHash: hash }, other),
  ).rejects.toBeInstanceOf(GatewayError);
  expect(chain.broadcasts).toEqual([]);
  expect(await store.pendingOperations()).toEqual([]);
});

test("API selects exact multi-price FIFO fills without persisting or mutating candidate orders", async () => {
  const { service, indexer, store, chain } = await setup();
  for (const [sequence, price] of [
    [3, 200_000_000n],
    [2, 199_000_000n],
    [1, 199_000_000n],
  ] as const) {
    const order = parseOrder({
      ...wire,
      maker: other,
      recipient: other,
      side: Side.Sell,
      salt: `0x${String(sequence).repeat(64)}`,
      quantity: "500000000000000000",
      limitPriceRawX18: String(price),
    });
    indexer.candidates.push({
      order,
      remaining: order.quantity,
      sequence: BigInt(sequence),
      orderHash: hashOrder(order, { chainId: 31337n, verifyingContract: env.exchange }),
    });
  }
  const before = structuredClone(indexer.candidates);
  chain.snapshotValue.marketOpenNotional = 299_000_000n;
  const prepared = await service.prepareOrder({ order: wire }, maker);
  expect(prepared.plan.makers.map((order) => String(order.salt))).toEqual([
    String(before[2]?.order.salt),
    String(before[1]?.order.salt),
  ]);
  expect(prepared.plan.filledQuantity).toBe(10n ** 18n);
  expect(prepared.plan.remainingQuantity).toBe(0n);
  expect(prepared.plan.executionQuote).toBe(199_000_000n);
  const plan = JSON.parse(
    JSON.stringify(prepared.plan, (_, value) =>
      typeof value === "bigint" ? String(value) : value,
    ),
  );
  await service.orderTransaction({ order: wire, signature: "0x12", plan }, maker);
  expect(chain.simulated).toBe(1);
  expect(indexer.candidates).toEqual(before);
  expect(await store.pendingOperations()).toEqual([]);
  expect(chain.broadcasts).toEqual([]);
  const firstCandidate = before[0];
  if (!firstCandidate) throw new Error("Fixture candidate missing");
  indexer.candidates[0] = { ...firstCandidate, orderHash: hash };
  await expect(service.prepareOrder({ order: wire }, maker)).rejects.toMatchObject({ status: 409 });
});

test("auth sessions are PostgreSQL-backed, reusable across API instances, and challenges are single-use", async () => {
  const { fixture, chain, indexer, service } = await setup();
  const challenge = await service.createChallenge({ address: maker });
  expect(challenge.message).toContain("https://probabl.test");
  const session = await service.verifyChallenge({
    address: maker,
    challengeId: challenge.challengeId,
    signature: "0x12",
  });
  const restarted = new GatewayService(
    env,
    createGatewayQueries(fixture.connect()),
    chain,
    indexer,
  );
  expect(await restarted.authenticate(`Bearer ${session.token}`)).toBe(maker);
  await expect(
    service.verifyChallenge({
      address: maker,
      challengeId: challenge.challengeId,
      signature: "0x12",
    }),
  ).rejects.toMatchObject({ status: 401 });
  for (const header of [undefined, "Basic x", "Bearer invalid", "Bearer a b"])
    await expect(service.authenticate(header)).rejects.toMatchObject({ status: 401 });
  for (const body of [null, [], {}, { address: "bad" }])
    await expect(service.createChallenge(body)).rejects.toBeInstanceOf(GatewayError);
  await expect(service.verifyChallenge({ address: maker, signature: "0x12" })).rejects.toThrow(
    "challengeId",
  );
  await expect(
    service.verifyChallenge({ address: maker, challengeId: "id", signature: "bad" }),
  ).rejects.toThrow("hex");
  chain.authValid = false;
  const invalid = await service.createChallenge({ address: maker });
  await expect(
    service.verifyChallenge({
      address: maker,
      challengeId: invalid.challengeId,
      signature: "0x12",
    }),
  ).rejects.toMatchObject({ status: 401 });
});

const wireJson = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item)),
  );

test("GTC and IOC preparation return bounded atomic plans without queues, broadcasts, or durable operations", async () => {
  const { service, store, chain } = await setup();
  for (const tif of [0, 1]) {
    const order = { ...wire, tif };
    const prepared = await service.prepareOrder({ order }, maker);
    expect(prepared.plan.filledQuantity).toBe(0n);
    expect(prepared.plan.remainingQuantity).toBe(BigInt(wire.quantity));
    expect(prepared.plan.deadline).toBe(1560n);
    const input = wireJson({ order, plan: prepared.plan, signature: "0x12" });
    const [first, second] = await Promise.all([
      service.orderTransaction(input, maker),
      service.orderTransaction(input, maker),
    ]);
    expect(first).toEqual(second);
    expect(first.transaction).toMatchObject({
      to: env.atomicRouter,
      from: maker,
      value: 0n,
      chainId: 31337,
    });
    expect(first.transaction.data.slice(0, 10)).not.toBe("0x");
  }
  expect(chain.simulated).toBe(4);
  expect(chain.broadcasts).toEqual([]);
  expect(await store.pendingOperations()).toEqual([]);
});

test("atomic preparation enforces wallet, balance, approval, signature, expiry, and simulation gates", async () => {
  const { service, chain, store } = await setup();
  const quote = await service.prepareOrder({ order: wire }, maker);
  const input = wireJson({ order: wire, plan: quote.plan, signature: "0x12" });
  const failures = [
    {
      change: () => {
        chain.balance = 0n;
      },
      reset: () => {
        chain.balance = 10n ** 25n;
      },
      code: GatewayErrorCode.BalanceInsufficient,
    },
    {
      change: () => {
        chain.allowance = 0n;
      },
      reset: () => {
        chain.allowance = 10n ** 25n;
      },
      code: GatewayErrorCode.ApprovalMissing,
    },
    {
      change: () => {
        chain.signatureValid = false;
      },
      reset: () => {
        chain.signatureValid = true;
      },
      code: GatewayErrorCode.SignatureInvalid,
    },
    {
      change: () => {
        chain.simulationError = true;
      },
      reset: () => {
        chain.simulationError = false;
      },
      code: GatewayErrorCode.SimulationFailed,
    },
    {
      change: () => {
        chain.executionTime = 1560n;
      },
      reset: () => {
        chain.executionTime = 1500n;
      },
      code: GatewayErrorCode.OrderExpired,
    },
  ];
  for (const failure of failures) {
    failure.change();
    await expect(service.orderTransaction(input, maker)).rejects.toMatchObject({
      code: failure.code,
    });
    failure.reset();
  }
  await expect(service.prepareOrder({ order: wire }, other)).rejects.toMatchObject({ status: 403 });
  await expect(service.orderTransaction(input, other)).rejects.toMatchObject({ status: 403 });
  for (const plan of [
    null,
    {},
    { ...input.plan, deadline: "0" },
    { ...input.plan, quantities: ["1"] },
  ])
    await expect(service.orderTransaction({ ...input, plan }, maker)).rejects.toBeInstanceOf(
      GatewayError,
    );
  expect(chain.broadcasts).toEqual([]);
  expect(await store.pendingOperations()).toEqual([]);
});

test("safety failures block both quote and transaction preparation without affecting cancellation", async () => {
  const { service, chain, indexer, store } = await setup();
  const quote = await service.prepareOrder({ order: wire }, maker);
  let checks = 0;
  const gated = new GatewayService(env, store, chain, indexer, {
    assertCanTrade: async () => {
      checks++;
      throw new Error("reconciliation freeze");
    },
  });
  await expect(gated.prepareOrder({ order: wire }, maker)).rejects.toThrow("reconciliation freeze");
  await expect(
    gated.orderTransaction(wireJson({ order: wire, plan: quote.plan, signature: "0x12" }), maker),
  ).rejects.toThrow("reconciliation freeze");
  expect(checks).toBe(2);
  expect(chain.broadcasts).toEqual([]);
});

test("atomic HTTP route prepares user bytes; removed submission endpoint cannot broadcast", async () => {
  const { service, chain } = await setup();
  const challenge = await service.createChallenge({ address: maker });
  const auth = await service.verifyChallenge({
    address: maker,
    challengeId: challenge.challengeId,
    signature: "0x12",
  });
  const quote = await service.prepareOrder({ order: wire }, maker);
  const body = JSON.stringify(wireJson({ order: wire, plan: quote.plan, signature: "0x12" }));
  const app = createApp(service);
  const headers = { authorization: `Bearer ${auth.token}`, "content-type": "application/json" };
  const response = await app.request("/v1/orders/transaction", { method: "POST", headers, body });
  expect(response.status).toBe(200);
  expect((await response.json()).transaction.to).toBe(env.atomicRouter);
  expect((await app.request("/v1/orders/submit", { method: "POST", headers, body })).status).toBe(
    404,
  );
  expect(chain.broadcasts).toEqual([]);
});

test("mainnet HTTP trading accepts unrelated authenticated wallets without registration and preserves ownership checks", async () => {
  const { service, chain, store } = await setup({ ...env, chainId: 4663 });
  const app = createApp(service);
  const post = (path: string, body: unknown, token?: string) =>
    app.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(wireJson(body)),
    });
  // Neither wallet appears in service configuration or has an administrative role.
  for (const address of [
    "0x3000000000000000000000000000000000000003",
    "0x4000000000000000000000000000000000000004",
  ]) {
    const challengeResponse = await post("/v1/auth/challenge", { address });
    expect(challengeResponse.status).toBe(200);
    const challenge = await challengeResponse.json();
    expect(challenge.message).toContain("Chain ID: 4663");
    const authResponse = await post("/v1/auth/verify", {
      address,
      challengeId: challenge.challengeId,
      signature: "0x12",
    });
    expect(authResponse.status).toBe(200);
    const { token } = await authResponse.json();
    for (const tif of [TimeInForce.Gtc, TimeInForce.Ioc]) {
      for (const side of [Side.Buy, Side.Sell]) {
        const order = { ...wire, maker: address, recipient: address, tif, side };
        const prepared = await post("/v1/orders/prepare", { order }, token);
        expect(prepared.status).toBe(200);
        const quote = await prepared.json();
        const input = { order, plan: quote.plan, signature: "0x12" };
        const transaction = await post("/v1/orders/transaction", input, token);
        expect(transaction.status).toBe(200);
        expect((await transaction.json()).transaction).toMatchObject({
          from: address,
          to: env.atomicRouter,
          chainId: 4663,
        });
        for (const path of ["/v1/orders/prepare", "/v1/orders/transaction"]) {
          expect((await post(path, input)).status).toBe(401);
          expect(
            (await post(path, { ...input, order: { ...order, maker: other } }, token)).status,
          ).toBe(403);
        }
      }
    }
  }
  expect(chain.simulated).toBe(8);
  expect(chain.broadcasts).toEqual([]);
  expect(await store.pendingOperations()).toEqual([]);
});

test("user-signed cancellation and position actions share the PostgreSQL outbox without a relayer allocation", async () => {
  const { chain, indexer, service } = await setup();
  indexer.orderValue = {
    confirmation: "confirmed",
    id: hash,
    maker,
    marketId: hash,
    remaining: "1",
    reserved: "1",
    status: "open",
    updatedBlock: "100",
  };
  expect((await service.prepareCancellation({ orderHash: hash }, maker)).transaction.from).toBe(
    maker,
  );
  const cancelled = await service.submitCancellation(
    { orderHash: hash, signedTransaction: "0x1234" },
    maker,
    "cancel-0001",
  );
  expect(cancelled.operation.state).toBe("broadcast");
  expect(
    (
      await service.submitCancellation(
        { orderHash: hash, signedTransaction: "0x1234" },
        maker,
        "cancel-0001",
      )
    ).attempts,
  ).toHaveLength(1);
  const merge = { marketId: hash, recipient: maker, collateral: "quote", amount: "100" };
  chain.approved = false;
  expect((await service.preparePositionAction("merge", merge, maker)).approval).not.toBeNull();
  await expect(
    service.submitPositionAction(
      "merge",
      { ...merge, signedTransaction: "0x1235" },
      maker,
      "merge-0001",
    ),
  ).rejects.toThrow("approval");
  chain.approved = true;
  expect(
    (
      await service.submitPositionAction(
        "merge",
        { ...merge, signedTransaction: "0x1235" },
        maker,
        "merge-0001",
      )
    ).operation.state,
  ).toBe("broadcast");
  if (!indexer.marketValue) throw new Error("market fixture missing");
  indexer.marketValue.state = 6;
  const redeem = { ...merge, collateral: "base", indexSets: ["1", "2"], amounts: ["101", "103"] };
  expect((await service.preparePositionAction("redeem", redeem, maker)).preview).toMatchObject({
    payout: 101n,
  });
  expect(
    (
      await service.submitPositionAction(
        "redeem",
        { ...redeem, signedTransaction: "0x1236" },
        maker,
        "redeem-0001",
      )
    ).operation.state,
  ).toBe("broadcast");
  // Retrying a pending cancellation rebroadcasts the same signed bytes, not a new nonce.
  expect(new Set(chain.broadcasts).size).toBe(3);
  for (const body of [
    { ...merge, amount: "0" },
    { ...merge, recipient: "bad" },
    { ...merge, collateral: "invalid" },
  ])
    await expect(service.preparePositionAction("merge", body, maker)).rejects.toBeInstanceOf(
      GatewayError,
    );
  await expect(
    service.preparePositionAction("redeem", { ...redeem, indexSets: ["1", "1"] }, maker),
  ).rejects.toThrow("position set");
  indexer.resolutionValue = null;
  await expect(service.preparePositionAction("redeem", redeem, maker)).rejects.toMatchObject({
    status: 503,
  });
  indexer.orderValue.status = "cancelled";
  await expect(service.prepareCancellation({ orderHash: hash }, maker)).rejects.toThrow(
    "cancelled",
  );
});

test("HTTP failures do not expose database query text and request logging preserves correlation", async () => {
  const { service } = await setup();
  const app = createApp(service);
  const invalid = await app.request("/v1/auth/challenge", { method: "POST", body: "{bad" });
  expect(invalid.status).toBe(400);
  expect(invalid.headers.get("x-request-id")).toBeTruthy();
  service.store.saveChallenge = async () => {
    throw new Error("SQL query with private bound parameters");
  };
  const failed = await app.request("/v1/auth/challenge", {
    method: "POST",
    body: JSON.stringify({ address: maker }),
  });
  expect(failed.status).toBe(500);
  const body = await failed.json();
  expect(body.error.retryable).toBe(true);
  expect(JSON.stringify(body)).not.toContain("SQL query");
  expect((await createApp().request("/ready")).status).toBe(503);
});
