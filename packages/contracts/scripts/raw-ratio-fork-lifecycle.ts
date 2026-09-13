/** Full v2 protocol tests against unchanged RH tokens, called only by the guarded fork runner. */
import {
  type Abi,
  type Address,
  createPublicClient,
  createWalletClient,
  erc20Abi,
  type Hex,
  http,
  keccak256,
  maxUint256,
  toHex,
  zeroHash,
} from "viem";
import { generatePrivateKey, type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { IndexerClient, ViemGatewayChain } from "../../../apps/api/src/chain.ts";
import {
  hashOrder,
  type Order,
  orderTypedData,
  quoteForExecution,
  quoteForReservation,
} from "../../domain/src/index.ts";
import { preparedOrder } from "../../gateway/src/index.ts";
import { forkReceipt } from "./fork-receipt.ts";
import { loadArtifact, loadConditionalTokensArtifact } from "./lib.ts";
import { verifyRawRatioFullstack } from "./raw-ratio-fullstack.ts";

interface Context {
  account: PrivateKeyAccount;
  privateKey: Hex;
  localUrl: string;
  ctf: Address;
  router: Address;
  authority: Address;
  quote: Address;
  stocks: readonly { symbol: string; address: Address }[];
  deploy(name: string, abi: Abi, bytecode: Hex, args?: readonly unknown[]): Promise<Address>;
  pass(name: string, detail?: unknown): void;
  record(value: unknown): void;
  save(name: string, value: unknown): Promise<unknown>;
}

export async function runRawRatioForkLifecycle(ctx: Context): Promise<void> {
  if (ctx.localUrl !== "http://127.0.0.1:18547") throw new Error("Private fork endpoint required");
  const local = createPublicClient({
    transport: http(ctx.localUrl),
    pollingInterval: 20,
    cacheTime: 0,
  });
  const rpc = <T>(method: string, params: unknown[] = []) =>
    local.request({ method, params } as never) as Promise<T>;
  if (!(await rpc<string>("web3_clientVersion")).toLowerCase().includes("anvil"))
    throw new Error("Anvil required");
  const buyer = ctx.account;
  const seller = privateKeyToAccount(generatePrivateKey());
  const assert = (condition: unknown, message: string): void => {
    if (!condition) throw new Error(message);
  };
  const read = (address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
    local.readContract({ address, abi, functionName, args });
  const balance = (token: Address, owner: Address) =>
    read(token, erc20Abi, "balanceOf", [owner]) as Promise<bigint>;
  const write = async (
    address: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[] = [],
    signer = buyer,
  ) => {
    const simulation = await local.simulateContract({
      account: signer,
      address,
      abi,
      functionName,
      args,
      type: "eip1559",
    });
    const hash = await createWalletClient({
      account: signer,
      transport: http(ctx.localUrl),
    }).writeContract({
      account: signer,
      address,
      abi,
      functionName,
      args,
      chain: null,
      maxFeePerGas: 100_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    // Anvil automines synchronously; snapshot rewinds must not share a block watcher.
    const receipt = await forkReceipt(local, hash);
    assert(receipt.status === "success", `${functionName} reverted`);
    ctx.record({
      address,
      functionName,
      args,
      from: signer.address,
      hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      status: receipt.status,
    });
    return simulation.result;
  };
  const initial = await rpc<Hex>("evm_snapshot");
  const deploymentBlock = (await local.getBlock()).number + 1n;
  try {
    const ctfAbi = (await loadConditionalTokensArtifact()).abi;
    const artifacts = Object.fromEntries(
      await Promise.all(
        [
          "MarketRegistry",
          "ManualResolutionController",
          "ConditionalExchange",
          "OrderValidator",
          "ConditionalSettlement",
          "ProtocolFeeVault",
          "PayoutVault",
          "AtomicOrderRouter",
          "OrderRecoveryRouter",
          "PositionRouter",
        ].map(async (name) => [name, await loadArtifact(name)] as const),
      ),
    );
    const abi = (name: string) => {
      const a = artifacts[name];
      if (!a) throw new Error(`Missing ${name}`);
      return a.abi;
    };
    const deploy = async (name: string, args: readonly unknown[]) => {
      const a = artifacts[name];
      if (!a) throw new Error(`Missing ${name}`);
      return ctx.deploy(name, a.abi, a.bytecode.object, args);
    };
    const registry = await deploy("MarketRegistry", [ctx.ctf, ctx.authority, ctx.quote]);
    const controller = await deploy("ManualResolutionController", [
      ctx.ctf,
      registry,
      ctx.authority,
    ]);
    const exchange = await deploy("ConditionalExchange", [ctx.ctf, registry, ctx.authority]);
    const validator = await deploy("OrderValidator", [exchange]);
    const feeVault = await deploy("ProtocolFeeVault", [ctx.ctf, ctx.authority]);
    const settlement = await deploy("ConditionalSettlement", [
      ctx.ctf,
      registry,
      exchange,
      feeVault,
    ]);
    const atomicRouter = await deploy("AtomicOrderRouter", [exchange, ctx.authority]);
    const recovery = await deploy("OrderRecoveryRouter", [exchange]);
    await write(registry, abi("MarketRegistry"), "setResolutionController", [controller]);
    await write(exchange, abi("ConditionalExchange"), "configureOrderValidator", [validator]);
    await write(exchange, abi("ConditionalExchange"), "configureSettlement", [settlement]);
    const payoutVault = (await local.readContract({
      address: exchange,
      abi: abi("ConditionalExchange"),
      functionName: "payoutVault",
    })) as Address;
    await write(exchange, abi("ConditionalExchange"), "configureAtomicRouter", [atomicRouter]);
    const place = async (order: Order, makers: Order[] = [], quantities: bigint[] = []) => {
      const signer = order.maker === buyer.address ? buyer : seller;
      const remaining = await Promise.all(
        makers.map(async (maker) => {
          const state = (await read(exchange, abi("ConditionalExchange"), "getOrderState", [
            hashOrder(maker, { chainId: 4663n, verifyingContract: exchange }),
          ])) as { remaining: bigint };
          return state.remaining;
        }),
      );
      const deadline = (await local.getBlock()).timestamp + 60n;
      return write(
        atomicRouter,
        abi("AtomicOrderRouter"),
        "placeAndMatch",
        [
          order,
          await signer.signTypedData(
            orderTypedData(order, {
              chainId: 4663n,
              verifyingContract: exchange,
            }),
          ),
          makers,
          quantities,
          remaining,
          deadline < order.expiry ? deadline : order.expiry,
        ],
        signer,
      );
    };
    assert(
      (await read(registry, abi("MarketRegistry"), "PROTOCOL_VERSION")) === 2,
      "Wrong protocol version",
    );
    await ctx.save("v2-local-deployments.json", {
      registry,
      controller,
      exchange,
      validator,
      settlement,
      feeVault,
      atomicRouter,
      recovery,
      ctf: ctx.ctf,
      authority: ctx.authority,
      router: ctx.router,
      priceFormat: "raw-unit-ratio-x18",
      protocolVersion: 2,
    });
    ctx.pass("V2 complete protocol graph deploys with canonical six-decimal USDG");
    await rpc("anvil_setBalance", [seller.address, toHex(10n ** 18n)]);
    for (const stock of ctx.stocks)
      await write(stock.address, erc20Abi, "transfer", [seller.address, 2n * 10n ** 18n]);
    for (const actor of [buyer, seller]) {
      for (const token of [ctx.quote, ...ctx.stocks.map((s) => s.address)]) {
        await write(token, erc20Abi, "approve", [exchange, maxUint256], actor);
        await write(token, erc20Abi, "approve", [ctx.ctf, maxUint256], actor);
      }
      await write(ctx.ctf, ctfAbi, "setApprovalForAll", [exchange, true], actor);
      await write(ctx.ctf, ctfAbi, "setApprovalForAll", [ctx.router, true], actor);
    }
    // Historical replay must run before snapshot rewinds reuse local block heights.
    // Keep this history canonical until both independent indexers have stopped.
    const fullstackSnapshot = await rpc<Hex>("evm_snapshot");
    try {
      await verifyRawRatioFullstack({
        ...ctx,
        seller,
        deploymentBlock,
        registry,
        controller,
        exchange,
        settlement,
        atomicRouter,
        payoutVault,
        recovery,
        abi,
        write,
      });
    } finally {
      assert(await rpc("evm_revert", [fullstackSnapshot]), "Fullstack snapshot restore failed");
    }
    const gateway = new ViemGatewayChain({
      chainId: 4663,
      rpcUrl: ctx.localUrl,
      exchange,
      marketRegistry: registry,
      conditionalTokens: ctx.ctf,
      positionRouter: ctx.router,
      atomicRouter: atomicRouter,
      payoutVault,
      indexerUrl: "http://127.0.0.1:1",
      authDomain: "localhost",
      authOrigin: "http://localhost",
    });
    await gateway.assertNetwork();
    const quantity = 10n ** 18n;
    const unitPrice = 200_000_000n;
    let counter = 0;
    for (const stock of ctx.stocks)
      for (const branch of [0, 1] as const)
        for (const buyFunding of [0, 1] as const)
          for (const sellFunding of [0, 1] as const)
            for (const outcome of ["yes", "no", "invalid"] as const) {
              const snapshot = await rpc<Hex>("evm_snapshot");
              const label = `${stock.symbol}/USDG branch=${branch} funding=${buyFunding}/${sellFunding} outcome=${outcome}`;
              try {
                const beforeStock =
                  (await balance(stock.address, buyer.address)) +
                  (await balance(stock.address, seller.address));
                const beforeQuote =
                  (await balance(ctx.quote, buyer.address)) +
                  (await balance(ctx.quote, seller.address));
                const now = (await local.getBlock()).timestamp;
                const uri = `ipfs://local-raw-ratio-case-${counter++}`;
                const config = {
                  baseToken: stock.address,
                  quoteToken: ctx.quote,
                  polymarketConditionId: keccak256(toHex(uri)),
                  polymarketYesIndex: 1n,
                  polymarketNoIndex: 2n,
                  tradingOpen: now,
                  tradingCutoff: now + 3600n,
                  rulesHash: keccak256(toHex("raw-ratio-test")),
                  metadataHash: keccak256(toHex(uri)),
                  priceTickRawX18: 10_000n,
                  baseStep: 10n ** 15n,
                  minNotional: 10_000n,
                  maxOrderQuantity: 10n * quantity,
                  maxOrderNotional: 10_000_000_000n,
                  maxWalletOpenNotional: 100_000_000_000n,
                  maxMarketOpenNotional: 1_000_000_000_000n,
                };
                const marketId = (await write(registry, abi("MarketRegistry"), "createMarket", [
                  config,
                  uri,
                ])) as Hex;
                await write(registry, abi("MarketRegistry"), "openMarket", [marketId]);
                const market = (await read(registry, abi("MarketRegistry"), "getMarket", [
                  marketId,
                ])) as {
                  conditionId: Hex;
                  stockYesPositionId: bigint;
                  stockNoPositionId: bigint;
                  quoteYesPositionId: bigint;
                  quoteNoPositionId: bigint;
                };
                const makeOrder = (side: 0 | 1, fundingKind: 0 | 1): Order => ({
                  maker: side === 0 ? buyer.address : seller.address,
                  recipient: side === 0 ? buyer.address : seller.address,
                  marketId,
                  branch,
                  side,
                  fundingKind,
                  quantity,
                  limitPriceRawX18: side === 0 ? 210_000_000n : unitPrice,
                  tif: 0,
                  expiry: now + 3500n,
                  nonce: 0n,
                  salt: keccak256(toHex(`${label}-${side}`)),
                  maxFeeBps: 0,
                });
                const bid = makeOrder(0, buyFunding);
                const ask = makeOrder(1, sellFunding);
                if (buyFunding === 1)
                  await write(ctx.ctf, ctfAbi, "splitPosition", [
                    ctx.quote,
                    zeroHash,
                    market.conditionId,
                    [1n, 2n],
                    quoteForReservation(quantity, bid.limitPriceRawX18),
                  ]);
                if (sellFunding === 1)
                  await write(
                    ctx.ctf,
                    ctfAbi,
                    "splitPosition",
                    [stock.address, zeroHash, market.conditionId, [1n, 2n], quantity],
                    seller,
                  );
                const safeBlock = (await local.getBlock()).number;
                // Exercise the production API's confirmed-block RPC snapshot and funding/signature paths.
                const healthSource = new IndexerClient("http://127.0.0.1:1");
                healthSource.market = async () =>
                  ({
                    baseTokenDecimals: 18,
                    quoteTokenDecimals: 6,
                    protocolVersion: 2,
                    priceFormat: "raw-unit-ratio-x18",
                  }) as Awaited<ReturnType<IndexerClient["market"]>>;
                healthSource.health = async () =>
                  ({ healthy: true, head: { confirmedBlock: safeBlock.toString() } }) as Awaited<
                    ReturnType<IndexerClient["health"]>
                  >;
                const validation = await gateway.snapshot(bid, healthSource);
                assert(
                  validation.market.baseTokenDecimals === 18 &&
                    validation.market.quoteTokenDecimals === 6,
                  "API metadata mismatch",
                );
                const funding = await gateway.funding(bid, validation.market, safeBlock);
                const preparation = preparedOrder(bid, validation, exchange, funding);
                assert(
                  preparation.notional === 210_000_000n &&
                    preparation.funding.amount === 210_000_000n,
                  "API raw USDG reservation mismatch",
                );
                const domain = { chainId: 4663n, verifyingContract: exchange };
                const bidSignature = await buyer.signTypedData(orderTypedData(bid, domain));
                assert(
                  await gateway.verifyOrderSignature(bid, bidSignature, safeBlock),
                  "API rejected v2 signature",
                );
                const legacy = orderTypedData(bid, domain);
                legacy.domain.version = "1";
                assert(
                  !(await gateway.verifyOrderSignature(
                    bid,
                    await buyer.signTypedData(legacy),
                    safeBlock,
                  )),
                  "Legacy signature accepted",
                );
                const part = 333n * 10n ** 15n;
                // A first small ask is consumed by the incoming bid; a later ask consumes
                // the bid's resting remainder. Every fill belongs to a new owner's placement.
                await place({ ...ask, quantity: part });
                await place(bid, [{ ...ask, quantity: part }], [part]);
                const state = (await read(exchange, abi("ConditionalExchange"), "getOrderState", [
                  hashOrder(bid, domain),
                ])) as { remaining: bigint; reserved: bigint };
                assert(
                  state.remaining === quantity - part &&
                    state.reserved === quoteForReservation(quantity - part, bid.limitPriceRawX18),
                  "Partial reservation mismatch",
                );
                const secondAsk = {
                  ...ask,
                  quantity: quantity - part,
                  salt: keccak256(toHex(`${label}-second-ask`)),
                };
                await place(secondAsk, [bid], [quantity - part]);
                const activeStock =
                  branch === 0 ? market.stockYesPositionId : market.stockNoPositionId;
                const activeQuote =
                  branch === 0 ? market.quoteYesPositionId : market.quoteNoPositionId;
                assert(
                  (await read(ctx.ctf, ctfAbi, "balanceOf", [buyer.address, activeStock])) ===
                    quantity,
                  "Buyer stock claim mismatch",
                );
                assert(
                  (await read(ctx.ctf, ctfAbi, "balanceOf", [seller.address, activeQuote])) ===
                    quoteForExecution(part, unitPrice) +
                      quoteForExecution(quantity - part, bid.limitPriceRawX18),
                  "Seller raw USDG claim mismatch",
                );
                assert(quoteForExecution(quantity, unitPrice) === unitPrice, "Price ratio drift");
                assert(
                  (await read(exchange, abi("ConditionalExchange"), "marketOpenNotional", [
                    marketId,
                  ])) === 0n,
                  "Cap reservation leaked",
                );
                if (branch === 0 && buyFunding === 0 && sellFunding === 0 && outcome === "yes") {
                  const extraAsk = { ...ask, salt: keccak256(toHex("atomicRouter-ask")) };
                  const extraBid = {
                    ...bid,
                    quantity: 2n * quantity,
                    tif: 1 as const,
                    salt: keccak256(toHex("atomicRouter-bid")),
                  };
                  const cashBefore = await balance(ctx.quote, buyer.address);
                  await place(extraAsk);
                  await place(extraBid, [extraAsk], [quantity / 2n]);
                  assert(
                    (await balance(ctx.quote, buyer.address)) === cashBefore - unitPrice / 2n,
                    "IOC improvement/remainder refund mismatch",
                  );
                  await write(exchange, abi("ConditionalExchange"), "setTradingPaused", [
                    true,
                    keccak256(toHex("test-pause")),
                  ]);
                  await write(
                    exchange,
                    abi("ConditionalExchange"),
                    "cancelOrder",
                    [hashOrder(extraAsk, domain)],
                    seller,
                  );
                  await write(exchange, abi("ConditionalExchange"), "setTradingPaused", [
                    false,
                    keccak256(toHex("test-resume")),
                  ]);
                  const expired = {
                    ...bid,
                    expiry: (await local.getBlock()).timestamp + 10n,
                    salt: keccak256(toHex("expiry")),
                  };
                  const before = await balance(ctx.quote, buyer.address);
                  await place(expired);
                  await rpc("evm_increaseTime", [11]);
                  await rpc("evm_mine");
                  await write(
                    exchange,
                    abi("ConditionalExchange"),
                    "releaseExpiredOrder",
                    [hashOrder(expired, domain)],
                    seller,
                  );
                  assert(
                    (await balance(ctx.quote, buyer.address)) === before,
                    "Expiry refund mismatch",
                  );
                  ctx.pass(
                    `${stock.symbol}/USDG IOC, price improvement, paused cancellation and expiry refunds`,
                  );
                }
                await write(registry, abi("MarketRegistry"), "freezeMarket", [
                  marketId,
                  keccak256(toHex("test-freeze")),
                ]);
                const yes = outcome === "no" ? 0n : 1n;
                const no = outcome === "yes" ? 0n : 1n;
                const evidence = keccak256(toHex(label));
                const commitment = await read(
                  controller,
                  abi("ManualResolutionController"),
                  "hashResolution",
                  [marketId, yes, no, yes + no, evidence, uri],
                );
                await write(registry, abi("MarketRegistry"), "beginResolution", [
                  marketId,
                  commitment,
                ]);
                await write(controller, abi("ManualResolutionController"), "resolveMarket", [
                  marketId,
                  yes,
                  no,
                  yes + no,
                  evidence,
                  uri,
                ]);
                for (const actor of [buyer, seller])
                  for (const [token, ids] of [
                    [stock.address, [market.stockYesPositionId, market.stockNoPositionId]],
                    [ctx.quote, [market.quoteYesPositionId, market.quoteNoPositionId]],
                  ] as const) {
                    const amounts = await Promise.all(
                      ids.map(
                        (id) =>
                          read(ctx.ctf, ctfAbi, "balanceOf", [
                            actor.address,
                            id,
                          ]) as Promise<bigint>,
                      ),
                    );
                    for (let i = 0; i < 2; i++)
                      if ((amounts[i] ?? 0n) > 0n)
                        await write(
                          ctx.router,
                          abi("PositionRouter"),
                          "redeemForUser",
                          [token, market.conditionId, [BigInt(i + 1)], [amounts[i]], actor.address],
                          actor,
                        );
                  }
                assert(
                  (await balance(stock.address, buyer.address)) +
                    (await balance(stock.address, seller.address)) ===
                    beforeStock,
                  "Stock conservation failed after redemption",
                );
                assert(
                  (await balance(ctx.quote, buyer.address)) +
                    (await balance(ctx.quote, seller.address)) ===
                    beforeQuote,
                  "USDG conservation failed after redemption",
                );
                for (const token of [stock.address, ctx.quote])
                  for (const holder of [ctx.ctf, ctx.router, exchange, settlement])
                    assert(
                      (await balance(token, holder)) === 0n,
                      "Protocol retained collateral after exit",
                    );
                ctx.pass(
                  `${label}: API, v2 signatures, two partial fills, exact reserves and complete redemption`,
                );
              } finally {
                assert(await rpc("evm_revert", [snapshot]), "Case snapshot restore failed");
              }
            }
  } finally {
    assert(await rpc("evm_revert", [initial]), "Initial snapshot restore failed");
  }
}
