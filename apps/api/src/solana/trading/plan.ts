import type { SolanaDatabase } from "@conditional-stocks/db/solana";
import {
  assertDelegatedOrder,
  big,
  delegationAddress,
  envelope,
  key,
  type OrderWire,
  orderId,
  orderWire,
  planOrder,
  quote,
  type SolanaClient,
} from "@conditional-stocks/solana-client";
import { liveOrder, type Snapshot } from "@conditional-stocks/solana-indexer/projection";
import { indexedSnapshot } from "../chain/indexed-snapshot.ts";

export function createOrderPlan(client: SolanaClient, db: SolanaDatabase, domain: string) {
  return async (order: OrderWire, snapshot?: Snapshot) => {
    const s = snapshot ?? (await indexedSnapshot(db, client, domain)),
      m = s.markets.get(order.marketId);
    if (!m) throw new Error("Unknown market");
    const now = BigInt(Math.floor(Date.now() / 1000)),
      q = BigInt(order.quantity),
      p = BigInt(order.limitPriceRawX18),
      notional = quote(q, p, true);
    if (
      s.config.paused ||
      m.state !== 2 ||
      now < big(m.terms.trading_open) ||
      now >= big(m.terms.trading_cutoff) ||
      BigInt(order.expiry) <= now ||
      BigInt(order.expiry) > big(m.terms.trading_cutoff)
    )
      throw new Error("Market or order is not currently tradable");
    if (
      q % big(m.terms.step) !== 0n ||
      p % big(m.terms.tick) !== 0n ||
      q > big(m.terms.max_quantity) ||
      notional < big(m.terms.min_notional) ||
      notional > big(m.terms.max_order)
    )
      throw new Error("Order violates market terms");
    const trader = s.traders.get(order.maker);
    if (order.delegate) {
      if (!trader) throw new Error("Delegation owner is not initialized");
      const grantAddress = delegationAddress(
        client.config,
        key(order.maker),
        key(order.delegate),
        client.program,
      );
      assertDelegatedOrder(
        order,
        s.delegations?.get(grantAddress.toBase58()),
        big(trader.delegation_epoch),
        client.config,
        now,
      );
    }
    if (trader && BigInt(order.nonce) < big(trader.minimum_nonce))
      throw new Error("Order nonce was invalidated");
    const candidates = [...s.orders]
      .filter(
        ([, o]) =>
          o.market.toBase58() === order.marketId &&
          o.terms.branch === order.branch &&
          o.terms.side !== order.side &&
          liveOrder(o, s, now),
      )
      .map(([id, o]) => ({
        order: orderWire(o),
        orderHash: id,
        remaining: big(o.remaining),
        sequence: big(o.sequence),
      }));
    const nextSequence = m.sequence[order.branch];
    if (!nextSequence) throw new Error("Market branch sequence is unavailable");
    const plan = planOrder({
      program: client.program,
      order,
      candidates,
      now,
      step: big(m.terms.step),
      nextSequence: big(nextSequence),
      makerFeeBps: s.config.maker_bps,
      takerFeeBps: s.config.taker_bps,
    });
    // Never silently split a reviewed order across transactions.
    await client.assertTransactionFits(
      key(order.delegate ?? order.maker),
      envelope([client.placement(order, plan, m)], client.program),
    );
    return {
      orderHash: orderId(order, client.program),
      order,
      notional: notional.toString(),
      plan,
      snapshotSlot: s.slot,
      atomicRouter: client.program.toBase58(),
      executionVersion: 1,
    };
  };
}
