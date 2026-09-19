import { expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import {
  SolanaClient,
  key,
  envelope,
  big,
  orderWire,
  digest,
  hex,
  planOrder,
  supportedMint,
  type Envelope,
  type OrderWire,
} from "@conditional-stocks/solana-client";
import { snapshot } from "@conditional-stocks/solana-indexer/projection";
import { reconcileVaults } from "../../solana-indexer/src/reconcile";
import { settings } from "../src/config";
import { Engine, owned, inventory } from "../src/engine";
import { Executor } from "../src/execution";
import { initialState } from "../src/state";

test.skipIf(!process.env.MM_VALIDATOR_FIXTURE)(
  "real local program: bounded SPL/Token-2022 funding, four quotes, maker fill, atomic replace, stale-feed cancellation",
  async () => {
    const directory = process.env.MM_VALIDATOR_FIXTURE!;
    const deployment = await Bun.file(directory + "/deployment.json").json();
    if (!["localhost", "127.0.0.1"].includes(new URL(deployment.rpcUrl).hostname))
      throw new Error("Only disposable localhost fixtures are allowed");
    const client = new SolanaClient(deployment),
      admin = Keypair.fromSecretKey(
        Uint8Array.from(await Bun.file(directory + "/admin.json").json()),
      ),
      alice = Keypair.fromSecretKey(
        Uint8Array.from(await Bun.file(directory + "/alice.json").json()),
      ),
      maker = Keypair.generate(),
      id = deployment.markets[0];
    await client.connection.confirmTransaction(
      await client.connection.requestAirdrop(maker.publicKey, 10_000_000_000),
      "confirmed",
    );
    for (const mint of [key(deployment.baseMint), key(deployment.quoteMint)]) {
      const metadata = await supportedMint(client.connection, mint);
      const ata = await getOrCreateAssociatedTokenAccount(
        client.connection,
        admin,
        mint,
        maker.publicKey,
        false,
        "confirmed",
        undefined,
        metadata.program,
      );
      await mintTo(
        client.connection,
        admin,
        mint,
        ata.address,
        admin,
        1_000_000_000n,
        [],
        undefined,
        metadata.program,
      );
    }
    const send = async (value: Envelope, wallet = alice) => {
      const tx = await client.prepareTransaction(wallet.publicKey, value, { pinWalletFees: true });
      tx.transaction.sign([wallet]);
      const signature = await client.connection.sendRawTransaction(tx.transaction.serialize(), {
        skipPreflight: false,
      });
      const result = await client.connection.confirmTransaction({ ...tx, signature }, "confirmed");
      expect(result.value.err).toBeNull();
    };
    for (const [orderId] of owned(await snapshot(client, "confirmed"), alice.publicKey, id))
      await send(envelope([await client.cancel(key(orderId), alice.publicKey)], client.program));
    const config = settings({
      markets: [
        {
          market: id,
          baseMint: deployment.baseMint,
          quoteMint: deployment.quoteMint,
          baseInventory: "1",
          quoteInventory: "10",
          orderQuote: "1",
          gapBps: 2000,
          basePriceMultiplier: "1",
          quotePriceMultiplier: "1",
        },
      ],
      maxTransferFeeBps: 500,
      dailySolBudgetLamports: "1000000000",
    });
    const state = initialState("local-test"),
      executor = new Executor(client, maker, config, state, () => {});
    let spot = 4n * 10n ** 18n,
      failFeed = false;
    const engine = new Engine(
      client,
      maker.publicKey,
      config,
      "http://127.0.0.1",
      state,
      () => {},
      executor,
      async () => {
        if (failFeed) throw new Error("Source stale");
        return { spot, probability: 400000n, observedAt: Date.now(), spread: 20000n };
      },
    );
    await engine.fund();
    expect((await client.wallet(key(id), maker.publicKey))?.balances.map(big)).toEqual([
      0n,
      0n,
      1000000n,
      1000000n,
      10000000n,
      10000000n,
    ]);
    const spend = state.spent;
    await engine.fund();
    expect(state.spent).toBe(spend); // No repeated deposits.
    await engine.cycle();
    let s = await snapshot(client, "confirmed"),
      orders = owned(s, maker.publicKey, id);
    expect(orders).toHaveLength(4);
    const ask = orders.find(([, o]) => o.terms.branch === 0 && o.terms.side === 1)!;
    const before = inventory(s, maker.publicKey, id),
      m = s.markets.get(id)!;
    const taker: OrderWire = {
      ...orderWire(ask[1]),
      maker: alice.publicKey.toBase58(),
      recipient: alice.publicKey.toBase58(),
      salt: hex(digest(crypto.randomUUID())),
      side: 0,
      fundingKind: 0,
      tif: 1,
      nonce: "0",
      quantity: ask[1].remaining.toString(),
    };
    const funding = await client.funding(taker);
    if (funding.approvalCall) await send(funding.approvalCall);
    const plan = planOrder({
      order: taker,
      candidates: [
        {
          order: orderWire(ask[1]),
          orderHash: ask[0],
          remaining: big(ask[1].remaining),
          sequence: big(ask[1].sequence),
        },
      ],
      now: BigInt(Math.floor(Date.now() / 1000)),
      step: big(m.terms.step),
      nextSequence: big(m.sequence[0]!),
      makerFeeBps: s.config.maker_bps,
      takerFeeBps: s.config.taker_bps,
      program: client.program,
    });
    await send(envelope([client.placement(taker, plan)], client.program));
    s = await snapshot(client, "confirmed");
    expect(inventory(s, maker.publicKey, id)[2]).toBe(before[2]! - big(ask[1].remaining));
    await engine.cycle();
    expect(owned(await snapshot(client, "confirmed"), maker.publicKey, id)).toHaveLength(4);
    const priorIds = new Set(
      owned(await snapshot(client, "confirmed"), maker.publicKey, id).map(([id]) => id),
    );
    spot = (spot * 101n) / 100n;
    await engine.cycle();
    orders = owned(await snapshot(client, "confirmed"), maker.publicKey, id);
    expect(orders).toHaveLength(4);
    expect(orders.every(([id]) => !priorIds.has(id))).toBe(true);
    failFeed = true;
    await engine.cycle();
    expect(owned(await snapshot(client, "confirmed"), maker.publicKey, id)).toEqual([]);
    const prior = await snapshot(client, "confirmed");
    const retiring = [...prior.orders].filter(([, o]) => o.owner.equals(maker.publicKey));
    const priorInventory = inventory(prior, maker.publicKey, id);
    const priorSol = await client.connection.getBalance(maker.publicKey, "confirmed");
    expect(retiring.length).toBeGreaterThan(0);
    await engine.reclaimRent();
    const recovered = await snapshot(client, "confirmed");
    expect([...recovered.orders.values()].filter((o) => o.owner.equals(maker.publicKey))).toEqual([]);
    expect(inventory(recovered, maker.publicKey, id)).toEqual(priorInventory);
    expect(await client.connection.getBalance(maker.publicKey, "confirmed")).toBeGreaterThan(priorSol);
    // The durable nonce survives, so the next cycle can use a fresh generation.
    expect(big(recovered.traders.get(maker.publicKey.toBase58())!.minimum_nonce)).toBeGreaterThan(0n);
    expect(
      (await reconcileVaults(client, await snapshot(client))).healthy,
    ).toBe(true);
  },
  120000,
);
