import { test, expect } from "bun:test";
import { resolve } from "node:path";
import { Keypair } from "@solana/web3.js";
import { Pool } from "pg";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  SolanaClient,
  assertSignInChallenge,
  key,
  hex,
  digest,
  orderId,
  envelope,
  verifyEnvelope,
  big,
  type Envelope,
  type OrderWire,
} from "../src/index.ts";
import { snapshot } from "../../../services/solana-indexer/src/projection.ts";
import {
  initializeHistory,
  replayHistory,
} from "../../../services/solana-indexer/src/history.ts";
import { reconcileVaults } from "../../../services/solana-indexer/src/reconcile.ts";

test.skipIf(process.env.SOLANA_APP_E2E !== "1")(
  "HTTP authentication → exact SPL funding → atomic trade → finalized indexing → withdrawal → durable replay",
  async () => {
    const deployment = await Bun.file(
      resolve(process.env.SOLANA_FIXTURE_DIR ?? ".local", "deployment.json"),
    ).json();
    if (
      !["127.0.0.1", "localhost"].includes(new URL(deployment.rpcUrl).hostname)
    )
      throw new Error("Only generated localhost fixtures are allowed");
    const bob = Keypair.fromSecretKey(
        Uint8Array.from(
          await Bun.file(
            resolve(process.env.SOLANA_FIXTURE_DIR ?? ".local", "bob.json"),
          ).json(),
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
    assertSignInChallenge(
      challenge,
      bob.publicKey.toBase58(),
      deployment,
      origin,
    );
    const proof = {
      address: bob.publicKey.toBase58(),
      challengeId: challenge.challengeId,
      signature: bs58.encode(
        nacl.sign.detached(
          new TextEncoder().encode(challenge.message),
          bob.secretKey,
        ),
      ),
    };
    const { token } = await post("/v1/auth/verify", proof);
    expect(typeof token).toBe("string");
    await expect(post("/v1/auth/verify", proof)).rejects.toThrow();
    const owner = bob.publicKey.toBase58(),
      marketId = deployment.markets[0],
      market = key(marketId),
      before = await client.wallet(market, bob.publicKey);
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
    };
    await expect(post("/v1/orders/prepare", { order })).rejects.toThrow();
    await expect(
      post(
        "/v1/orders/prepare",
        { order: { ...order, maker: Keypair.generate().publicKey.toBase58() } },
        token,
      ),
    ).rejects.toThrow();
    const prepared = await post("/v1/orders/prepare", { order }, token);
    expect(prepared.orderHash).toBe(orderId(order));
    expect(prepared.plan.filledQuantity).toBe("1000000");
    const send = async (value: Envelope) => {
      const built = await client.prepareTransaction(bob.publicKey, value);
      built.transaction.sign([bob]);
      const signature = await client.connection.sendRawTransaction(
        built.transaction.serialize(),
        {
          skipPreflight: false,
        },
      );
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
      verifyEnvelope(funding.approvalCall, {
        transaction: prepared.funding.approvalCall,
      });
      await send(funding.approvalCall);
    }
    const reviewed = envelope([client.placement(order, prepared.plan)]),
      response = await post(
        "/v1/orders/transaction",
        { order, plan: prepared.plan },
        token,
      );
    verifyEnvelope(reviewed, response);
    const signature = await send(reviewed);
    expect(big((await client.order(key(orderId(order)))).filled)).toBe(
      1_000_000n,
    );
    expect(
      big((await client.wallet(market, bob.publicKey))!.balances[2]!) -
        big(before!.balances[2]!),
    ).toBe(1_000_000n);
    const until = Date.now() + 45_000;
    let trades: any[] = [];
    while (Date.now() < until) {
      const r = await fetch(indexer + "/trades?marketId=" + marketId);
      if (r.ok) {
        trades = (await r.json()).trades;
        if (trades.some((t) => t.transactionHash === signature)) break;
      }
      await Bun.sleep(500);
    }
    expect(trades.filter((t) => t.transactionHash === signature)).toHaveLength(
      1,
    );
    expect(
      trades.find((t) => t.transactionHash === signature).fillQuantity,
    ).toBe("1000000");
    const m = await client.market(market),
      withdraw = envelope(
        client.withdraw(market, bob.publicKey, m.mints[2]!, 2, 500_000n),
      );
    const withdrawal = await post(
      "/v1/payouts/withdraw/prepare",
      {
        marketId,
        asset: m.mints[2]!.toBase58(),
        tokenId: "2",
        amount: "500000",
        recipient: owner,
      },
      token,
    );
    verifyEnvelope(withdraw, withdrawal);
    await send(withdraw);
    // Price improvement leaves whole quote credits. Exercise the same HTTP
    // withdrawal path on underlying Token-2022 as well as classic claim tokens.
    const quoteCredit = big(
      (await client.wallet(market, bob.publicKey))!.balances[1]!,
    );
    expect(quoteCredit).toBeGreaterThanOrEqual(1000n);
    const wholeWithdrawal = envelope(
      await client.withdrawCredit(market, bob.publicKey, m.mints[1]!, 1, 1000n),
    );
    const wholeResponse = await post(
      "/v1/payouts/withdraw/prepare",
      {
        marketId,
        asset: m.mints[1]!.toBase58(),
        tokenId: "1",
        amount: "1000",
        recipient: owner,
      },
      token,
    );
    verifyEnvelope(wholeWithdrawal, wholeResponse);
    await send(wholeWithdrawal);
    expect(
      big((await client.wallet(market, bob.publicKey))!.balances[1]!),
    ).toBe(quoteCredit - 1000n);
    const balances = await fetch(
      indexer + "/balances/" + owner + "?token=" + m.mints[1]!.toBase58(),
    );
    expect(balances.ok).toBe(true);
    const wholeBalance = await balances.json();
    expect(wholeBalance.decimals).toBe(m.decimals[1]);
    expect(BigInt(wholeBalance.canonicalBalance)).toBeGreaterThan(0n);
    expect(wholeBalance.tokenProgram).toBe(
      (await client.connection.getAccountInfo(m.mints[1]!))!.owner.toBase58(),
    );
    const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    if (!process.env.TEST_DATABASE_URL)
      throw new Error(
        "An isolated TEST_DATABASE_URL is required for replay assertions",
      );
    try {
      const state = await snapshot(client),
        domain = "test:" + crypto.randomUUID();
      await initializeHistory(db);
      await replayHistory(db, client, domain, state.slot);
      const count = async () =>
        Number(
          (
            await db.query(
              "SELECT count(*) FROM solana_events WHERE domain=$1",
              [domain],
            )
          ).rows[0].count,
        );
      const beforeReplay = await count();
      expect(beforeReplay).toBeGreaterThan(0);
      // New client instance simulates process state loss; checkpoint and dedup are persistent.
      await replayHistory(db, new SolanaClient(deployment), domain, state.slot);
      expect(await count()).toBe(beforeReplay);
      expect(
        (await reconcileVaults(client, [...state.markets.keys()], state.slot))
          .healthy,
      ).toBe(true);
    } finally {
      await db.end();
    }
  },
  120_000,
);
