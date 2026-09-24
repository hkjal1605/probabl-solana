import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { replayHistory } from "../../../services/solana-indexer/src/history.ts";
import { snapshot } from "../../../services/solana-indexer/src/projection.ts";
import { reconcileVaults } from "../../../services/solana-indexer/src/reconcile.ts";
import { createSolanaDatabase } from "../../db/src/solana/connection";
import {
  allLegs,
  assertSignInChallenge,
  baseRaw,
  big,
  claimAsset,
  coder,
  DELEGATE_TRADE,
  digest,
  type Envelope,
  envelope,
  hex,
  key,
  liveLegs,
  type OrderAccount,
  type OrderWire,
  orderCollateral,
  orderId,
  orderSalt,
  SolanaClient,
  verifyEnvelope,
} from "../src/index.ts";

test.skipIf(process.env.SOLANA_APP_E2E !== "1")(
  "HTTP authentication → exact SPL funding → atomic trade → finalized indexing → withdrawal → durable replay",
  async () => {
    const deployment = await Bun.file(
      resolve(process.env.SOLANA_FIXTURE_DIR ?? ".local", "deployment.json"),
    ).json();
    if (!["127.0.0.1", "localhost"].includes(new URL(deployment.rpcUrl).hostname))
      throw new Error("Only generated localhost fixtures are allowed");
    const bob = Keypair.fromSecretKey(
        Uint8Array.from(
          await Bun.file(resolve(process.env.SOLANA_FIXTURE_DIR ?? ".local", "bob.json")).json(),
        ),
      ),
      client = new SolanaClient(deployment);
    const origin = "http://localhost:3001",
      api = process.env.API_URL ?? "http://127.0.0.1:3000",
      indexer = process.env.INDEXER_URL ?? "http://127.0.0.1:42069";
    async function post(path: string, body: unknown, token?: string) {
      const response = await fetch(api + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: "Bearer " + token } : {}),
        },
        body: JSON.stringify(body),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(path + " " + JSON.stringify(value));
      return value;
    }
    const wrongOrigin = await fetch(api + "/v1/auth/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address: bob.publicKey.toBase58(),
        origin: "https://untrusted.example",
      }),
    });
    expect(wrongOrigin.status).toBe(403);
    const challenge = await post("/v1/auth/challenge", {
      address: bob.publicKey.toBase58(),
      origin,
    });
    assertSignInChallenge(challenge, bob.publicKey.toBase58(), deployment, origin);
    const proof = {
      address: bob.publicKey.toBase58(),
      challengeId: challenge.challengeId,
      signature: bs58.encode(
        nacl.sign.detached(new TextEncoder().encode(challenge.message), bob.secretKey),
      ),
    };
    const { token } = await post("/v1/auth/verify", proof);
    expect(typeof token).toBe("string");
    await expect(post("/v1/auth/verify", proof)).rejects.toThrow();
    const owner = bob.publicKey.toBase58(),
      marketId = deployment.markets[0],
      market = key(marketId),
      before = await client.wallet(market, bob.publicKey),
      listed = await client.market(market);
    const order: OrderWire = {
      maker: owner,
      recipient: owner,
      marketId,
      salt: hex(digest(crypto.randomUUID())),
      quantity: "1000000",
      limitPriceRawX18: "6000000000000000000",
      expiry: String(Math.floor(Date.now() / 1000) + 600),
      nonce: String(Date.now()),
      maxFeeBps: 0,
      branch: 0,
      side: 0,
      fundingKind: 0,
      tif: 1,
      // Accept every listed issuer leg of the NVDA book.
      bases: allLegs(listed.bases),
    };
    const prepared = await post("/v1/orders/prepare", { order }, token);
    expect(prepared.orderHash).toBe(orderId(order));
    expect(prepared.plan.filledQuantity).toBe("1000000");
    const send = async (value: Envelope) => {
      const built = await client.prepareTransaction(bob.publicKey, value);
      built.transaction.sign([bob]);
      const signature = await client.connection.sendRawTransaction(built.transaction.serialize(), {
        skipPreflight: false,
      });
      const result = await client.connection.confirmTransaction(
        {
          signature,
          blockhash: built.blockhash,
          lastValidBlockHeight: built.lastValidBlockHeight,
        },
        "confirmed",
      );
      expect(result.value.err).toBeNull();
      return signature;
    };
    const funding = await client.funding(order);
    if (funding.approvalCall) {
      await send(funding.approvalCall);
    }
    const reviewed = envelope([client.placement(order, prepared.plan)]),
      response = await post("/v1/orders/transaction", { order, plan: prepared.plan }, token);
    verifyEnvelope(reviewed, response);
    const legs = await liveLegs(client.connection, listed, client.config, client.program);
    // Each fill delivers the ask's own issuer claim, converted from share units
    // to raw issuer units at that leg's live multiplier (rounded down).
    const expected = new Map<number, bigint>();
    for (const [i, maker] of prepared.plan.makers.entries()) {
      const c = orderCollateral(maker),
        leg = legs[c]!;
      expect(leg.tradable).toBe(true);
      expected.set(
        c,
        (expected.get(c) ?? 0n) +
          baseRaw(BigInt(prepared.plan.quantities[i]), leg.scale, leg.multiplier, false),
      );
    }
    expect(expected.size).toBeGreaterThan(0);
    const signature = await send(reviewed);
    expect(big((await client.order(key(orderId(order)))).filled)).toBe(1_000_000n);
    const filledWallet = (await client.wallet(market, bob.publicKey))!;
    for (const [c, raw] of expected)
      expect(
        big(filledWallet.balances[claimAsset(c, 0)]!) - big(before?.balances[claimAsset(c, 0)] ?? 0),
      ).toBe(raw);
    const [claimLeg, claimRaw] = [...expected][0]!,
      claim = claimAsset(claimLeg, 0),
      half = claimRaw / 2n;
    // The streamed index commits a slot when the cluster confirms it, the same
    // moment RPC confirmation returns: the fill is visible without extra delay.
    const confirmedAt = Date.now(),
      until = confirmedAt + 45_000;
    let trades: any[] = [];
    let visibleAfter = Number.POSITIVE_INFINITY;
    while (Date.now() < until) {
      const r = await fetch(indexer + "/trades?marketId=" + marketId);
      if (r.ok) {
        trades = (await r.json()).trades;
        if (trades.some((t) => t.transactionHash === signature)) {
          visibleAfter = Date.now() - confirmedAt;
          break;
        }
      }
      await Bun.sleep(20);
    }
    expect(visibleAfter).toBeLessThan(1_000);
    expect(trades.filter((t) => t.transactionHash === signature)).toHaveLength(1);
    expect(trades.find((t) => t.transactionHash === signature).fillQuantity).toBe("1000000");
    const m = await client.market(market),
      withdraw = envelope(client.withdraw(market, bob.publicKey, m.mints[claim]!, claim, half));
    const withdrawal = await post(
      "/v1/payouts/withdraw/prepare",
      {
        scope: "market",
        marketId,
        asset: m.mints[claim]!.toBase58(),
        tokenId: String(claim),
        amount: String(half),
        recipient: owner,
      },
      token,
    );
    verifyEnvelope(withdraw, withdrawal);
    await send(withdraw);
    const claimRedeposit = envelope([
      client.deposit(market, bob.publicKey, m.mints[claim]!, claim, half),
    ]);
    const claimDepositQuote = await post(
      "/v1/vault/deposit/prepare",
      {
        scope: "market",
        marketId,
        asset: String(m.mints[claim]),
        tokenId: String(claim),
        amount: String(half),
      },
      token,
    );
    try {
      verifyEnvelope(claimRedeposit, claimDepositQuote);
    } catch {
      verifyEnvelope(
        envelope([
          client.initializeWallet(market, bob.publicKey),
          client.deposit(market, bob.publicKey, m.mints[claim]!, claim, half),
        ]),
        claimDepositQuote,
      );
    }
    await send(claimDepositQuote.transaction);
    expect(big((await client.wallet(market, bob.publicKey))!.balances[claim]!)).toBe(
      big(before?.balances[claim] ?? 0) + claimRaw,
    );
    // Price improvement leaves whole quote credits. Exercise the same HTTP
    // withdrawal path on underlying Token-2022 as well as classic claim tokens.
    const quoteCredit = big(
      (await client.assetCredit(key(deployment.quoteMint), bob.publicKey))!.available,
    );
    expect(quoteCredit).toBeGreaterThanOrEqual(1000n);
    const wholeWithdrawal = envelope(
      await client.withdrawCredit(market, bob.publicKey, m.mints[0]!, 0, 1000n),
    );
    const wholeResponse = await post(
      "/v1/payouts/withdraw/prepare",
      {
        scope: "global",
        asset: m.mints[0]!.toBase58(),
        tokenId: "0",
        amount: "1000",
        recipient: owner,
      },
      token,
    );
    verifyEnvelope(wholeWithdrawal, wholeResponse);
    await send(wholeWithdrawal);
    expect(
      big((await client.assetCredit(key(deployment.quoteMint), bob.publicKey))!.available),
    ).toBe(quoteCredit - 1000n);
    const balances = await fetch(
      indexer + "/balances/" + owner + "?token=" + m.mints[0]!.toBase58(),
    );
    expect(balances.ok).toBe(true);
    const wholeBalance = await balances.json();
    expect(wholeBalance.decimals).toBe(m.decimals[0]);
    expect(BigInt(wholeBalance.canonicalBalance)).toBeGreaterThan(0n);
    expect(wholeBalance.tokenProgram).toBe(
      (await client.connection.getAccountInfo(m.mints[0]!))!.owner.toBase58(),
    );
    const deposit = await post(
      "/v1/vault/deposit/prepare",
      {
        scope: "global",
        asset: String(m.mints[0]),
        amount: "1000000",
      },
      token,
    );
    await send(deposit.transaction);
    const deposited = big((await client.assetCredit(m.mints[0]!, bob.publicKey))!.available);
    expect(deposited).toBe(quoteCredit - 1000n + BigInt(deposit.minimumReceived));
    // Bootstrap liquidity may include resting quote-funded bids of this wallet;
    // their reservations are part of the global reserved balance.
    const orderDiscriminator = coder.accounts.accountDiscriminator("Order");
    let baseReserved = 0n;
    for (const { account } of await client.connection.getProgramAccounts(client.program, {
      commitment: "confirmed",
      filters: [{ memcmp: { offset: 40, bytes: owner } }],
    })) {
      if (!account.data.subarray(0, 8).equals(orderDiscriminator)) continue;
      const resting = coder.accounts.decode("Order", account.data) as OrderAccount;
      if (resting.status === 1 && resting.terms.side === 0 && resting.terms.funding === 0)
        baseReserved += big(resting.reserved);
    }
    let lastBalance: unknown = null;
    const waitBalance = async (available: bigint, reserved: bigint) => {
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        const response = await fetch(indexer + "/balances/" + owner + "?token=" + m.mints[0]);
        if (response.ok) {
          const value = await response.json();
          lastBalance = value;
          if (
            value.vaultAvailable === String(available) &&
            value.reserved === String(reserved + baseReserved)
          ) {
            expect(value.creditBalances).toEqual({}); // No per-market copies of global cash.
            return value;
          }
        }
        await Bun.sleep(500);
      }
      throw new Error(
        "Global available/reserved balances were not indexed: " +
          JSON.stringify({ available: String(available), reserved: String(reserved + baseReserved), lastBalance }),
      );
    };
    await waitBalance(deposited, 0n);
    const permissionUrl = api + "/v1/trading/permission?owner=" + owner;
    const firstPermission = await (await fetch(permissionUrl)).json();
    expect(firstPermission.available).toBe(true);
    expect(firstPermission.active).toBe(false);
    const delegate = key(firstPermission.delegate);
    await send(
      envelope([
        client.approveDelegate(bob.publicKey, delegate, {
          market: null,
          expiresAt: BigInt(Math.floor(Date.now() / 1000) + 86_400),
          maxOrderQuote: 1_000_000n,
          totalQuote: 10_000_000n,
          maxFeeBps: 100,
          permissions: DELEGATE_TRADE,
        }),
      ]),
    );
    let permission = firstPermission;
    const permissionDeadline = Date.now() + 45_000;
    while (Date.now() < permissionDeadline) {
      permission = await (await fetch(permissionUrl)).json();
      if (permission.active) break;
      await Bun.sleep(500);
    }
    expect(permission.active).toBe(true);
    const nonce = BigInt(Date.now());
    const delegated: OrderWire = {
      ...order,
      delegate: String(delegate),
      salt: orderSalt(nonce, crypto.getRandomValues(new Uint8Array(32))),
      nonce: String(nonce),
      quantity: "10000",
      limitPriceRawX18: "1000000000000000000",
      tif: 0,
    };
    const delegatedResult = await post("/v1/trading/submit", { order: delegated }, token);
    expect(delegatedResult.orderHash).toBe(orderId(delegated));
    expect((await post("/v1/trading/submit", { order: delegated }, token)).signature).toBe(
      delegatedResult.signature,
    );
    await expect(
      post(
        "/v1/trading/submit",
        {
          order: { ...delegated, quantity: "11000" },
        },
        token,
      ),
    ).rejects.toThrow("identity mismatch");
    const placed = await client.order(key(delegatedResult.orderHash));
    expect(String(placed.delegate)).toBe(String(delegate));
    expect(big(placed.reserved)).toBe(10_000n);
    await waitBalance(deposited - 10_000n, 10_000n);
    const delegatedCancel = await post(
      "/v1/orders/cancel/prepare",
      {
        orderHash: delegatedResult.orderHash,
      },
      token,
    );
    await send(delegatedCancel.transaction);
    await waitBalance(deposited, 0n);
    await send(envelope([client.revokeDelegate(bob.publicKey, delegate)]));
    const revoked: OrderWire = {
      ...delegated,
      salt: orderSalt(nonce + 1n, crypto.getRandomValues(new Uint8Array(32))),
      nonce: String(nonce + 1n),
    };
    await expect(post("/v1/trading/submit", { order: revoked }, token)).rejects.toThrow();
    const resting: OrderWire[] = [];
    for (const id of deployment.markets) {
      const next = {
        ...order,
        marketId: id,
        bases: allLegs((await client.market(key(id))).bases),
        salt: hex(digest(crypto.randomUUID())),
        quantity: "100000",
        limitPriceRawX18: "1000000000000000000",
        tif: 0,
      };
      const review = await post("/v1/orders/prepare", { order: next });
      expect(review.plan.filledQuantity).toBe("0");
      const built = await post("/v1/orders/transaction", { order: next, plan: review.plan }, token);
      await send(built.transaction);
      resting.push(next);
    }
    await waitBalance(deposited - 200000n, 200000n);
    // The NO cash claim from the first market is not spendable in the second,
    // even though both use the same underlying USDC mint.
    const wrongClaim = {
      ...order,
      marketId: deployment.markets[1],
      bases: allLegs((await client.market(key(deployment.markets[1]))).bases),
      salt: hex(digest(crypto.randomUUID())),
      branch: 1,
      fundingKind: 1,
      quantity: "1000",
      limitPriceRawX18: "1000000000000000000",
      tif: 0,
    };
    const claimReview = await post("/v1/orders/prepare", { order: wrongClaim });
    await expect(
      post("/v1/orders/transaction", { order: wrongClaim, plan: claimReview.plan }, token),
    ).rejects.toThrow("simulation failed");
    await expect(
      post(
        "/v1/payouts/withdraw/prepare",
        {
          scope: "market",
          marketId: deployment.markets[1],
          // Market 0's USDC-NO claim is not a claim of market 1.
          asset: String(m.mints[claimAsset(0, 1)]),
          tokenId: String(claimAsset(0, 1)),
          amount: "1",
        },
        token,
      ),
    ).rejects.toThrow("does not belong");
    for (const o of resting) {
      const cancel = await post("/v1/orders/cancel/prepare", { orderHash: orderId(o) }, token);
      await send(cancel.transaction);
    }
    await waitBalance(deposited, 0n);
    const db = createSolanaDatabase({ connectionString: process.env.TEST_DATABASE_URL! });
    if (!process.env.TEST_DATABASE_URL)
      throw new Error("An isolated TEST_DATABASE_URL is required for replay assertions");
    try {
      const state = await snapshot(client),
        domain = "test:" + crypto.randomUUID();
      await db.verify();
      await replayHistory(db, client, domain, state.slot, state);
      const count = () => db.eventCount(domain);
      const beforeReplay = await count();
      expect(beforeReplay).toBeGreaterThan(0);
      // New client instance simulates process state loss; checkpoint and dedup are persistent.
      await replayHistory(db, new SolanaClient(deployment), domain, state.slot, state);
      expect(await count()).toBe(beforeReplay);
      expect((await reconcileVaults(client, state)).healthy).toBe(true);
    } finally {
      await db.close();
    }
  },
  180_000,
);

test.skipIf(process.env.SOLANA_APP_E2E !== "1")(
  "the indexer's lookup keeper appends every market's accounts and resting makers' PDAs; the API serves them",
  async () => {
    const { marketLookupAddresses, participantLookupAddresses, key: toKey } = await import("../src/index.ts");
    const { AddressLookupTableAccount } = await import("@solana/web3.js");
    const deployment = await Bun.file(
      resolve(process.env.SOLANA_FIXTURE_DIR ?? ".local", "deployment.json"),
    ).json();
    const client = new SolanaClient(deployment);
    const api = process.env.API_URL ?? "http://127.0.0.1:3000",
      indexer = process.env.INDEXER_URL ?? "http://127.0.0.1:42069";
    const orders = (await (await fetch(indexer + "/orders")).json()) as {
      orders?: { maker: string; marketId: string; status: string }[];
    };
    const resting = (orders.orders ?? []).filter((o) => o.status === "open");
    expect(resting.length).toBeGreaterThan(0);
    const expected = new Set<string>();
    for (const marketId of new Set(resting.map((o) => o.marketId))) {
      const market = await client.market(toKey(marketId));
      for (const a of marketLookupAddresses(client.config, toKey(marketId), market, client.program)) expected.add(String(a));
      for (const maker of new Set(resting.filter((o) => o.marketId === marketId).map((o) => o.maker)))
        for (const a of participantLookupAddresses(client.config, toKey(marketId), market, toKey(maker), [], client.program))
          expected.add(String(a));
    }
    // The keeper runs every 5s; entries are usable once finalized.
    let kept = new Set<string>(),
      tables: string[] = [];
    for (let attempt = 0; attempt < 90 && [...expected].some((a) => !kept.has(a)); attempt++) {
      await Bun.sleep(1000);
      tables = ((await (await fetch(indexer + "/lookup-tables")).json()) as { tables: string[] }).tables;
      const infos = await client.connection.getMultipleAccountsInfo(tables.map(toKey), "finalized");
      kept = new Set(
        infos.flatMap((info) => (info ? AddressLookupTableAccount.deserialize(info.data).addresses.map(String) : [])),
      );
    }
    expect([...expected].filter((a) => !kept.has(a))).toEqual([]);
    // The API compiles with the same tables within its refresh interval.
    let served: string[] = [];
    for (let attempt = 0; attempt < 20 && served.length < tables.length; attempt++) {
      served = ((await (await fetch(api + "/v1/lookup-tables")).json()) as { tables: string[] }).tables;
      if (served.length < tables.length) await Bun.sleep(1000);
    }
    expect(new Set(served)).toEqual(new Set(tables));
  },
  180_000,
);

test.skipIf(process.env.SOLANA_APP_E2E !== "1")(
  "the streamed index matches a direct RPC read of the same confirmed slot",
  async () => {
    const deployment = await Bun.file(
      resolve(process.env.SOLANA_FIXTURE_DIR ?? ".local", "deployment.json"),
    ).json();
    const client = new SolanaClient(deployment);
    const indexer = process.env.INDEXER_URL ?? "http://127.0.0.1:42069";
    const chain = await snapshot(client, "confirmed");
    // Wait until the stream has committed at least the RPC read's slot.
    for (let attempt = 0; attempt < 100; attempt++) {
      const health = (await (await fetch(indexer + "/health")).json()) as { head: { confirmedBlock: string } };
      if (Number(health.head.confirmedBlock) >= chain.slot) break;
      await Bun.sleep(50);
    }
    const view = (await (await fetch(indexer + "/orders")).json()) as {
      orders: { id: string; status: string; remaining: string; filled: string }[];
    };
    const streamed = new Map(
      view.orders.filter((o) => o.status === "open").map((o) => [o.id, [o.remaining, o.filled]]),
    );
    const direct = new Map(
      [...chain.orders]
        .filter(([, o]) => o.status === 1)
        .map(([id, o]) => [id, [o.remaining.toString(), o.filled.toString()]]),
    );
    expect(streamed.size).toBeGreaterThan(0);
    expect(streamed).toEqual(direct);
    const markets = (await (await fetch(indexer + "/markets")).json()) as { markets: { id: string }[] };
    expect(new Set(markets.markets.map((m) => m.id))).toEqual(new Set(chain.markets.keys()));
  },
  60_000,
);
