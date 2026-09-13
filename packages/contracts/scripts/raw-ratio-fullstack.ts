/** Local-only integration of Ponder, HTTP quotes, user-paid atomic placement and replay. */
import { resolve } from "node:path";
import { createDatabase, databaseUrl } from "@conditional-stocks/db/connection";
import { createGatewayQueries } from "@conditional-stocks/db/gateway";
import type { ReconciliationSnapshot } from "@conditional-stocks/db/reconciliation/types";
import {
  type Abi,
  type Address,
  createPublicClient,
  createWalletClient,
  erc20Abi,
  type Hex,
  http,
  keccak256,
  toHex,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { createApp } from "../../../apps/api/src/app.ts";
import { IndexerClient, ViemGatewayChain } from "../../../apps/api/src/chain.ts";
import { GatewayService } from "../../../apps/api/src/service.ts";
import {
  atomicTransaction,
  verifyAtomicResponse,
} from "../../../apps/ui/src/lib/trading/atomic.ts";
import { createOrder } from "../../../apps/ui/src/lib/trading/order.ts";
import {
  payoutWithdrawal,
  verifyPayoutResponse,
} from "../../../apps/ui/src/lib/trading/payouts.ts";
import { loadIndexerEnvironment } from "../../../services/rh-indexer/src/environment.ts";
import {
  hashProjection,
  runReconciliation,
} from "../../../services/rh-indexer/src/reconciliation/engine.ts";
import {
  assertMarketUnits,
  hashOrder,
  type Order,
  orderTypedData,
} from "../../domain/src/index.ts";
import { parseOrder } from "../../gateway/src/index.ts";
import { forkReceipt } from "./fork-receipt.ts";
import { loadArtifact } from "./lib.ts";

interface Context {
  account: PrivateKeyAccount;
  privateKey: Hex; // Ephemeral Anvil signer, never persisted.
  seller: PrivateKeyAccount;
  localUrl: string;
  deploymentBlock: bigint;
  registry: Address;
  controller: Address;
  exchange: Address;
  settlement: Address;
  atomicRouter: Address;
  payoutVault: Address;
  recovery: Address;
  authority: Address;
  ctf: Address;
  router: Address;
  quote: Address;
  stocks: readonly { symbol: string; address: Address }[];
  abi(name: string): Abi;
  write(
    address: Address,
    abi: Abi,
    name: string,
    args?: readonly unknown[],
    signer?: PrivateKeyAccount,
  ): Promise<unknown>;
  pass(name: string, detail?: unknown): void;
  save(name: string, value: unknown): Promise<unknown>;
  record(value: unknown): void;
}

export async function verifyRawRatioFullstack(ctx: Context): Promise<void> {
  if (ctx.localUrl !== "http://127.0.0.1:18547") throw new Error("Private fork required");
  const local = createPublicClient({ transport: http(ctx.localUrl), pollingInterval: 20 });
  const rpc = (method: string, params: unknown[] = []) =>
    local.request({ method, params } as never);
  const connectionString = databaseUrl(process.env.DATABASE_URL);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(connectionString).hostname))
    throw new Error("Fullstack rehearsal requires an isolated loopback PostgreSQL database");
  const database = createDatabase({ connectionString, chainId: 4663, exchange: ctx.exchange });
  await database.migrate();
  const indexerUrl = "http://127.0.0.1:18548";
  const rebuiltUrl = "http://127.0.0.1:18550";
  const children: { process: ReturnType<typeof Bun.spawn>; logs: Promise<void> }[] = [];
  const store = createGatewayQueries(database);
  let apiServer: ReturnType<typeof Bun.serve> | undefined;
  const json = <T>(value: T): string =>
    JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item));
  const assert = (condition: unknown, message: string): void => {
    if (!condition) throw new Error(message);
  };
  const fetchJson = async <T>(url: string): Promise<T> => {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`${url}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<T>;
  };
  const waitFor = async (label: string, ready: () => Promise<boolean>): Promise<void> => {
    const deadline = Date.now() + 90_000;
    let last = "not ready";
    while (Date.now() < deadline) {
      try {
        if (await ready()) return;
      } catch (error) {
        last = String(error);
      }
      for (const child of children)
        if (child.process.exitCode !== null) throw new Error(`Indexer exited during ${label}`);
      await Bun.sleep(250);
    }
    throw new Error(`Timeout: ${label}: ${last}`);
  };
  const environment = {
    ...process.env,
    ROBINHOOD_CHAIN_ID: "4663",
    ROBINHOOD_RPC_URL: ctx.localUrl,
    DEPLOYMENT_BLOCK: ctx.deploymentBlock.toString(),
    INDEXER_CONFIRMATION_BLOCKS: "1",
    INDEXER_FINALITY_BLOCKS: "2",
    INDEXER_FINALITY_MODE: "local-depth",
    INDEXER_CONFIRMATION_MODE: "sequencer-depth",
    INDEXER_MAX_HEAD_AGE_SECONDS: "315360000",
    INDEXER_POLLING_INTERVAL_MS: "250",
    PONDER_DISABLE_CACHE: "true",
    PONDER_TELEMETRY_DISABLED: "true",
    DO_NOT_TRACK: "1",
    DATABASE_URL: connectionString,
    INDEXER_END_BLOCK: "",
    CONDITIONAL_TOKENS_ADDRESS: ctx.ctf,
    EXCHANGE_ADDRESS: ctx.exchange,
    ATOMIC_ORDER_ROUTER_ADDRESS: ctx.atomicRouter,
    PAYOUT_VAULT_ADDRESS: ctx.payoutVault,
    MARKET_REGISTRY_ADDRESS: ctx.registry,
    ORDER_RECOVERY_ROUTER_ADDRESS: ctx.recovery,
    POSITION_ROUTER_ADDRESS: ctx.router,
    PROTOCOL_AUTHORITY_ADDRESS: ctx.authority,
    RESOLUTION_CONTROLLER_ADDRESS: ctx.controller,
    SETTLEMENT_ADDRESS: ctx.settlement,
  };
  const startIndexer = async (port: number, name: string): Promise<void> => {
    const probe = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("reserved") });
    probe.stop(true);
    const child = Bun.spawn(
      [
        "bun",
        "scripts/ponder.ts",
        "dev",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
        "--disable-ui",
      ],
      {
        cwd: resolve(import.meta.dir, "../../../services/rh-indexer"),
        env: { ...environment, DATABASE_SCHEMA: name.replaceAll("-", "_") },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const logs = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).then(async ([stdout, stderr]) => {
      await ctx.save(`${name}-logs.json`, { stdout, stderr });
    });
    children.push({ process: child, logs });
  };
  const advance = async (): Promise<bigint> => {
    for (let i = 0; i < 3; i++) await rpc("evm_mine");
    return (await local.getBlock()).number;
  };
  const sync = async (): Promise<void> => {
    const target = await advance();
    await waitFor(
      "primary indexer caught up",
      async () =>
        BigInt(
          (await fetchJson<{ head: { indexedBlock: string } }>(`${indexerUrl}/indexer/health`)).head
            .indexedBlock,
        ) >= target,
    );
  };
  try {
    const marketIds: { id: Hex; symbol: string }[] = [];
    for (const stock of ctx.stocks) {
      const now = (await local.getBlock()).timestamp;
      const uri = `ipfs://raw-ratio-fullstack-${stock.symbol}`;
      const config = {
        baseToken: stock.address,
        quoteToken: ctx.quote,
        polymarketConditionId: keccak256(toHex(uri)),
        polymarketYesIndex: 1n,
        polymarketNoIndex: 2n,
        tradingOpen: now,
        tradingCutoff: now + 3600n,
        rulesHash: keccak256(toHex(uri)),
        metadataHash: keccak256(toHex(uri)),
        priceTickRawX18: 10_000n,
        baseStep: 10n ** 15n,
        minNotional: 10_000n,
        maxOrderQuantity: 10n ** 19n,
        maxOrderNotional: 10_000_000_000n,
        maxWalletOpenNotional: 100_000_000_000n,
        maxMarketOpenNotional: 1_000_000_000_000n,
      };
      const id = (await ctx.write(ctx.registry, ctx.abi("MarketRegistry"), "createMarket", [
        config,
        uri,
      ])) as Hex;
      await ctx.write(ctx.registry, ctx.abi("MarketRegistry"), "openMarket", [id]);
      marketIds.push({ id, symbol: stock.symbol });
    }
    await startIndexer(18548, "primary");
    await sync();
    const apiEnvironment = {
      authDomain: "localhost",
      authOrigin: "http://localhost",
      chainId: 4663,
      conditionalTokens: ctx.ctf,
      exchange: ctx.exchange,
      indexerUrl,
      atomicRouter: ctx.atomicRouter,
      payoutVault: ctx.payoutVault,
      marketRegistry: ctx.registry,
      positionRouter: ctx.router,
      rpcUrl: ctx.localUrl,
    };
    const gatewayChain = new ViemGatewayChain(apiEnvironment);
    await gatewayChain.assertNetwork();
    const service = new GatewayService(
      apiEnvironment,
      store,
      gatewayChain,
      new IndexerClient(indexerUrl),
    );
    apiServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createApp(service).fetch });
    const apiUrl = `http://127.0.0.1:${apiServer.port}`;
    const api = async <T>(path: string, body: unknown, token?: string): Promise<T> => {
      const response = await fetch(`${apiUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: json(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Gateway ${path}: ${await response.text()}`);
      return response.json() as Promise<T>;
    };
    const sessions = new Map<Address, string>();
    for (const actor of [ctx.account, ctx.seller]) {
      const challenge = await api<{ message: string; challengeId: string }>("/v1/auth/challenge", {
        address: actor.address,
      });
      const session = await api<{ token: string }>("/v1/auth/verify", {
        address: actor.address,
        challengeId: challenge.challengeId,
        signature: await actor.signMessage({ message: challenge.message }),
      });
      sessions.set(actor.address, session.token);
    }
    for (const { id, symbol } of marketIds) {
      const market = await fetchJson<Record<string, unknown>>(`${indexerUrl}/markets/${id}`);
      assertMarketUnits(market);
      assert(
        market.baseTokenDecimals === 18 && market.quoteTokenDecimals === 6,
        "Indexer decimals mismatch",
      );
      const now = (await local.getBlock()).timestamp;
      const orders: Order[] = [];
      const placements: unknown[] = [];
      for (const [actor, side, price, quantity] of [
        [ctx.seller, "sell", "200", "1"],
        [ctx.account, "buy", "210", "2"],
      ] as const) {
        const wire = createOrder(
          {
            ...market,
            account: actor.address,
            branch: "YES",
            cutoff: new Date(Number(now + 3500n) * 1000).toISOString(),
            funding: "whole",
            marketId: id,
            price,
            quantity,
            side,
            tif: "gtc",
          },
          { nowMs: Number(now * 1000n), salt: keccak256(toHex(`${id}-${side}`)) },
        );
        const preparation = await api<{
          fundingReady: boolean;
          notional: string;
          funding: { amount: string; decimals: number };
          schemaVersion: number;
          plan: unknown;
        }>("/v1/orders/prepare", { order: wire }, sessions.get(actor.address));
        assert(
          preparation.schemaVersion === 2 && preparation.fundingReady,
          "API could not prepare real-token order",
        );
        assert(
          preparation.notional === (side === "buy" ? "420000000" : "200000000"),
          "HTTP notional scaling mismatch",
        );
        if (side === "buy")
          assert(
            preparation.funding.amount === "420000000" && preparation.funding.decimals === 6,
            "HTTP escrow units mismatch",
          );
        const order = parseOrder(wire);
        orders.push(order);
        const signature = await actor.signTypedData(
          orderTypedData(order, { chainId: 4663n, verifyingContract: ctx.exchange }),
        );
        const expected = atomicTransaction({
          order: wire,
          plan: preparation.plan,
          signature,
          account: actor.address,
          config: { chainId: 4663, exchange: ctx.exchange, atomicRouter: ctx.atomicRouter },
          nowSeconds: (await local.getBlock()).timestamp,
        });
        const prepared = await api<unknown>(
          "/v1/orders/transaction",
          {
            order: wire,
            plan: preparation.plan,
            signature,
          },
          sessions.get(actor.address),
        );
        const transaction = verifyAtomicResponse(expected, prepared);
        const hash = await createWalletClient({
          account: actor,
          transport: http(ctx.localUrl),
        }).sendTransaction({
          account: actor,
          chain: null,
          to: transaction.to,
          data: transaction.data,
          value: BigInt(transaction.value),
          maxFeePerGas: 100_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
        });
        const receipt = await forkReceipt(local, hash);
        assert(receipt.status === "success", "Atomic user transaction reverted");
        const evidence = {
          hash,
          from: actor.address,
          plan: preparation.plan,
          gasUsed: receipt.gasUsed,
          blockNumber: receipt.blockNumber,
          status: receipt.status,
        };
        placements.push(evidence);
        ctx.record({ functionName: "placeAndMatch", ...evidence });
        // The next incoming order must see the just-persisted resting maker.
        await sync();
      }
      await sync();
      const bid = orders[1];
      if (!bid) throw new Error("Missing bid");
      const bidHash = hashOrder(bid, { chainId: 4663n, verifyingContract: ctx.exchange });
      const indexed = await fetchJson<{ remaining: string; reserved: string; filled: string }>(
        `${indexerUrl}/orders/${bidHash}`,
      );
      assert(
        indexed.remaining === "1000000000000000000" &&
          indexed.reserved === "210000000" &&
          indexed.filled === "1000000000000000000",
        "Indexer partial reservation units mismatch",
      );
      await api(
        "/v1/orders/cancel/prepare",
        { orderHash: bidHash },
        sessions.get(ctx.account.address),
      );
      await ctx.write(ctx.exchange, ctx.abi("ConditionalExchange"), "cancelOrder", [bidHash]);
      await sync();
      const cancelled = await fetchJson<{ status: string; remaining: string; filled: string }>(
        `${indexerUrl}/orders/${bidHash}`,
      );
      assert(
        cancelled.status === "cancelled" &&
          cancelled.remaining === "0" &&
          cancelled.filled === indexed.filled,
        "Cancelled order history lost the actual filled quantity",
      );
      const positions = await fetchJson<{
        positions: {
          marketId: string;
          stockYes: string;
          quoteNo: string;
          baseTokenDecimals: number;
          quoteTokenDecimals: number;
        }[];
      }>(`${indexerUrl}/positions/${ctx.account.address}`);
      const position = positions.positions.find(
        (row) => row.marketId.toLowerCase() === id.toLowerCase(),
      );
      assert(
        position?.stockYes === "1000000000000000000" &&
          position.quoteNo === "200000000" &&
          position.baseTokenDecimals === 18 &&
          position.quoteTokenDecimals === 6,
        "Indexed claim units mismatch",
      );
      const whole = await fetchJson<{ canonicalBalance: string; decimals: number }>(
        `${indexerUrl}/balances/${ctx.account.address}?token=${ctx.quote}`,
      );
      const rawBalance = await local.readContract({
        abi: erc20Abi,
        address: ctx.quote,
        functionName: "balanceOf",
        args: [ctx.account.address],
      });
      assert(
        whole.decimals === 6 && BigInt(whole.canonicalBalance) === rawBalance,
        "Indexed USDG canonical balance mismatch",
      );
      await ctx.save(`fullstack-${symbol}.json`, {
        market,
        placements,
        indexedPartialBid: indexed,
        indexedCancelledBid: cancelled,
        positions,
        whole,
      });
      ctx.pass(
        `${symbol}/USDG UI input → HTTP plan → same user transaction fills → indexed claims/cancellation`,
      );
    }
    // Two independently signed users race the same reviewed maker in one mined block.
    // Its recipient deliberately rejects, so the winner also exercises the full credit path.
    const walletArtifact = await loadArtifact("AtomicTestWallet", "AtomicPlacement.t");
    const userWallet = createWalletClient({ account: ctx.account, transport: http(ctx.localUrl) });
    const deployment = await userWallet.deployContract({
      abi: walletArtifact.abi,
      bytecode: walletArtifact.bytecode.object,
      args: [ctx.account.address],
      chain: null,
    });
    const receiver = (await forkReceipt(local, deployment)).contractAddress;
    if (!receiver) throw new Error("Missing test recipient");
    await ctx.write(receiver, walletArtifact.abi, "setBehavior", [true, false]);
    const first = marketIds[0];
    if (!first) throw new Error("Missing concurrent market");
    const market = await fetchJson<Record<string, unknown>>(`${indexerUrl}/markets/${first.id}`);
    assertMarketUnits(market);
    const makeWire = (actor: PrivateKeyAccount, side: "buy" | "sell", label: string) =>
      createOrder(
        {
          ...market,
          account: actor.address,
          branch: "YES",
          cutoff: new Date(Number(awaitTime + 3500n) * 1000).toISOString(),
          funding: "whole",
          marketId: first.id,
          price: "200",
          quantity: "0.1",
          side,
          tif: "gtc",
        },
        { nowMs: Number(awaitTime * 1000n), salt: keccak256(toHex(label)) },
      );
    const awaitTime = (await local.getBlock()).timestamp;
    const placeThroughApi = async (
      wire: ReturnType<typeof createOrder>,
      actor: PrivateKeyAccount,
    ) => {
      const quote = await api<{ plan: unknown }>(
        "/v1/orders/prepare",
        { order: wire },
        sessions.get(actor.address),
      );
      const signature = await actor.signTypedData(
        orderTypedData(parseOrder(wire), { chainId: 4663n, verifyingContract: ctx.exchange }),
      );
      const expected = atomicTransaction({
        order: wire,
        plan: quote.plan,
        signature,
        account: actor.address,
        config: { chainId: 4663, exchange: ctx.exchange, atomicRouter: ctx.atomicRouter },
        nowSeconds: (await local.getBlock()).timestamp,
      });
      const response = await api<unknown>(
        "/v1/orders/transaction",
        { order: wire, signature, plan: quote.plan },
        sessions.get(actor.address),
      );
      return verifyAtomicResponse(expected, response);
    };
    const makerWire = {
      ...makeWire(ctx.seller, "sell", "rejecting-race-maker"),
      recipient: receiver,
    };
    const makerTx = await placeThroughApi(makerWire, ctx.seller);
    await ctx.write(ctx.quote, erc20Abi, "transfer", [ctx.seller.address, 40_000_000n]);
    const submit = (actor: PrivateKeyAccount, tx: { to: Address; data: Hex }) =>
      createWalletClient({ account: actor, transport: http(ctx.localUrl) }).sendTransaction({
        chain: null,
        to: tx.to,
        data: tx.data,
        value: 0n,
        gas: 8_000_000n,
        maxFeePerGas: 100_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      });
    assert(
      (await forkReceipt(local, await submit(ctx.seller, makerTx))).status === "success",
      "Race maker did not rest",
    );
    await sync();
    const [firstTx, secondTx] = await Promise.all([
      placeThroughApi(makeWire(ctx.account, "buy", "race-one"), ctx.account),
      placeThroughApi(makeWire(ctx.seller, "buy", "race-two"), ctx.seller),
    ]);
    let race: Hex[] = [];
    await rpc("evm_setAutomine", [false]);
    try {
      race = await Promise.all([submit(ctx.account, firstTx), submit(ctx.seller, secondTx)]);
      await rpc("evm_mine");
    } finally {
      await rpc("evm_setAutomine", [true]);
    }
    const receipts = await Promise.all(race.map((hash) => forkReceipt(local, hash)));
    assert(receipts[0]?.blockNumber === receipts[1]?.blockNumber, "Race was not in one block");
    assert(
      receipts.filter((receipt) => receipt.status === "success").length === 1,
      "Concurrent quotes double-filled or both failed",
    );
    for (const receipt of receipts)
      ctx.record({
        functionName: "checked-atomic-race",
        hash: receipt.transactionHash,
        status: receipt.status,
        gasUsed: receipt.gasUsed,
        blockNumber: receipt.blockNumber,
      });
    await sync();
    type Credit = {
      beneficiary: string;
      asset: string;
      tokenId: string;
      amount: string;
      decimals: number;
    };
    const credits = () =>
      fetchJson<{ vault: Address; payouts: Credit[] }>(`${indexerUrl}/payouts/${receiver}`);
    const credit = (await credits()).payouts[0];
    assert(
      credit?.amount === "20000000" &&
        credit.decimals === 6 &&
        credit.asset.toLowerCase() === ctx.ctf.toLowerCase(),
      "Rejected quote claims were not indexed exactly",
    );
    if (!credit) throw new Error("Missing payout credit");
    const receiverChallenge = await api<{ message: string; challengeId: string }>(
      "/v1/auth/challenge",
      { address: receiver },
    );
    const receiverSession = await api<{ token: string }>("/v1/auth/verify", {
      address: receiver,
      challengeId: receiverChallenge.challengeId,
      signature: await ctx.account.signMessage({ message: receiverChallenge.message }),
    });
    const withdrawHalf = async () => {
      const expected = payoutWithdrawal({
        credit,
        amount: 10_000_000n,
        recipient: ctx.account.address,
        account: receiver,
        config: { chainId: 4663, payoutVault: ctx.payoutVault, conditionalTokens: ctx.ctf },
      });
      const response = await api<unknown>(
        "/v1/payouts/withdraw/prepare",
        {
          asset: credit.asset,
          tokenId: credit.tokenId,
          amount: "10000000",
          recipient: ctx.account.address,
        },
        receiverSession.token,
      );
      const tx = verifyPayoutResponse(expected, response);
      await ctx.write(receiver, walletArtifact.abi, "execute", [tx.to, tx.data]);
      await sync();
      assert(
        (await credits()).payouts[0]?.amount === "10000000",
        "Partial withdrawal projection is wrong",
      );
    };
    const rewind = await rpc("evm_snapshot");
    await withdrawHalf();
    assert(await rpc("evm_revert", [rewind]), "Credit reorg rewind failed");
    await rpc("evm_increaseTime", [5]);
    await sync();
    assert(
      (await credits()).payouts[0]?.amount === "20000000",
      "Reorg did not restore beneficiary credit",
    );
    await withdrawHalf();
    await ctx.save("fullstack-payout-race.json", {
      vault: ctx.payoutVault,
      recipient: receiver,
      race: receipts,
      credits: await credits(),
      rollbackVerified: true,
    });
    ctx.pass(
      "Same-block competing quotes settle once; rejected recipient credit supports authenticated partial withdrawal and reorg rollback",
    );
    const primary = await fetchJson<ReconciliationSnapshot>(
      `${indexerUrl}/internal/reconciliation-snapshot?deep=true`,
    );
    const reconciliation = await runReconciliation(primary, loadIndexerEnvironment(environment), {
      deep: true,
      exclusiveConditionalTokens: true,
    });
    await ctx.save("fullstack-reconciliation.json", reconciliation);
    assert(
      reconciliation.status === "ok" && reconciliation.issues.length === 0,
      "Deep reconciliation failed",
    );
    await startIndexer(18550, "rebuilt");
    await waitFor(
      "clean indexer replay",
      async () =>
        (await fetchJson<{ head: { indexedBlock: string } }>(`${rebuiltUrl}/indexer/health`)).head
          .indexedBlock === primary.state.indexedBlock,
    );
    const rebuilt = await fetchJson<ReconciliationSnapshot>(
      `${rebuiltUrl}/internal/reconciliation-snapshot?deep=true`,
    );
    assert(hashProjection(primary) === hashProjection(rebuilt), "Fresh Ponder replay differs");
    await ctx.save("fullstack-rebuild.json", {
      primaryHash: hashProjection(primary),
      rebuiltHash: hashProjection(rebuilt),
      indexedBlock: primary.state.indexedBlock,
      projectionVersion: 3,
    });
    ctx.pass("Real-token live indexer deep reconciliation and clean database replay match exactly");
  } finally {
    apiServer?.stop(true);
    for (const child of children) {
      if (child.process.exitCode === null) child.process.kill("SIGTERM");
      await child.process.exited;
      await child.logs;
    }
    await database.close();
  }
}
