/** Fill capacity on the compiled program: one taker crossing every protocol
 * maker (MAX_MAKERS) of distinct owners in ONE transaction. Static market
 * tables alone cannot carry it (packet limit); appending the resting makers'
 * PDAs exactly as the indexer's LookupKeeper does makes it fit and execute. */
import { beforeAll, describe, expect, test } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  MAX_MAKERS,
  SIZING_BLOCKHASH,
  budgetedInstructions,
  coder,
  compileTransactionMessage,
  key,
  legBit,
  orderId,
  participantLookupAddresses,
  type OrderWire,
} from "../src/index.ts";
import { ValidatorHarness } from "./validator-harness.ts";

const WAD = 10n ** 18n;
const rpc = process.env.SOLANA_TEST_RPC;
describe.skipIf(!rpc)("one placement fills every protocol maker with keeper lookup tables", () => {
  const h = new ValidatorHarness(rpc ?? "http://127.0.0.1:8899");
  const bob = Keypair.generate();
  let quote: PublicKey;

  beforeAll(async () => {
    await h.airdrop(h.admin.publicKey, bob.publicKey);
    quote = await h.plainMint(6, TOKEN_PROGRAM_ID);
    await h.initialize(quote);
    await h.fund(quote, bob.publicKey, 10n ** 13n);
    await h.send([h.client.depositPool(bob.publicKey, quote, 10n ** 12n)], bob);
  }, 180_000);

  test(`a bid crossing ${MAX_MAKERS} distinct makers executes atomically in one transaction`, async () => {
    const base = await h.plainMint(6, TOKEN_PROGRAM_ID);
    const market = await h.market([base]);
    await h.client.market(market);
    const makers = Array.from({ length: MAX_MAKERS }, () => Keypair.generate());
    await h.airdrop(...makers.map((k) => k.publicKey));
    await h.send([h.client.initializeWallet(market, bob.publicKey, h.admin.publicKey)]);
    const asks: OrderWire[] = [];
    for (const [i, maker] of makers.entries()) {
      await h.fund(base, maker.publicKey, 10n ** 9n);
      await h.send([h.client.initializeWallet(market, maker.publicKey, h.admin.publicKey)]);
      await h.send([h.client.depositPool(maker.publicKey, base, 10n ** 6n)], maker);
      const ask = h.order(market, maker, {
        side: 1,
        bases: legBit(1),
        quantity: "1000",
        limitPriceRawX18: String(WAD / 2n + BigInt(i) * (WAD / 10n)),
      });
      await h.place(ask, maker);
      asks.push(ask);
    }
    const bid = h.order(market, bob, {
      side: 0,
      bases: legBit(1),
      quantity: String(1000 * MAX_MAKERS),
      limitPriceRawX18: String(2n * WAD),
      tif: 1,
    });
    const { market: account, plan } = await h.plan(bid, asks);
    expect(plan.makers).toHaveLength(MAX_MAKERS);
    const ix = h.client.placement(bid, plan, account);

    // Static deployment/market entries only: the makers' PDAs are 32-byte keys.
    h.tables = [];
    await h.lookupMarket(market);
    expect(() =>
      compileTransactionMessage(bob.publicKey, budgetedInstructions([ix], h.client.program), SIZING_BLOCKHASH, h.tables),
    ).toThrow("packet limit");

    // Keeper behaviour: append each resting maker's participant PDAs.
    await h.lookup(
      makers.flatMap((maker) =>
        participantLookupAddresses(h.client.config, market, account, maker.publicKey, [], h.client.program),
      ),
    );
    const message = compileTransactionMessage(
      bob.publicKey,
      budgetedInstructions([ix], h.client.program),
      SIZING_BLOCKHASH,
      h.tables,
    );
    expect(message.staticAccountKeys.length + message.numAccountKeysFromLookups).toBeLessThanOrEqual(64);
    const signature = await h.send([ix], bob);

    // Every maker filled by that single transaction.
    const tx = await h.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const trades = (tx?.meta?.logMessages ?? [])
      .filter((line) => line.startsWith("Program data: "))
      .map((line) => coder.events.decode(line.slice("Program data: ".length)))
      .filter((e) => e?.name === "Trade");
    expect(trades).toHaveLength(MAX_MAKERS);
    for (const ask of asks) {
      const order = await h.client.order(key(orderId(ask, h.client.program)));
      expect(order.status).toBe(2);
      expect(order.remaining.toString()).toBe("0");
    }
    const taker = await h.client.order(key(orderId(bid, h.client.program)));
    expect(taker.filled.toString()).toBe(String(1000 * MAX_MAKERS));
    expect(tx?.meta?.computeUnitsConsumed ?? 0).toBeLessThan(400_000);
  }, 600_000);
});
