import {
  type AtomicPlan,
  allLegs,
  assertDelegatedOrder,
  big,
  delegationAddress,
  envelope,
  key,
  legsOf,
  type LiveLeg,
  liveLegs,
  MAX_MAKERS,
  type MarketAccount,
  type OrderWire,
  orderId,
  orderWire,
  planOrder,
  quote,
  type SolanaClient,
  singleBase,
} from "@conditional-stocks/solana-client";
import { liveOrder, type Snapshot } from "@conditional-stocks/solana-indexer/projection";
import type { TransactionInstruction } from "@solana/web3.js";

export type LegReader = (market: MarketAccount) => Promise<Record<number, LiveLeg>>;

/** A buy accepts a non-empty subset of the listed legs, at least one of them
 * tradable; a sell delivers exactly one listed, tradable leg. Without live leg
 * state only the on-chain listing (and a sell leg's active flag) is checked. */
export function assertOrderLegs(
  order: Pick<OrderWire, "side" | "bases">,
  m: MarketAccount,
  legs?: Record<number, Pick<LiveLeg, "tradable" | "halt">>,
) {
  if (
    !Number.isInteger(order.bases) ||
    order.bases <= 0 ||
    (order.bases & ~allLegs(m.bases)) !== 0
  )
    throw new Error("Order selects an issuer token that is not listed in this market");
  if (order.side === 1) {
    const collateral = singleBase(order.bases);
    if (collateral === null) throw new Error("A sell order delivers exactly one issuer token");
    const leg = legs?.[collateral];
    if (legs ? !leg?.tradable : !m.legs[collateral - 1]?.active)
      throw new Error(
        `This issuer token is halted (${leg?.halt ?? (legs ? "unreadable" : "delisted")}); it cannot be sold now`,
      );
    return;
  }
  if (legs && !legsOf(order.bases).some((c) => legs[c]?.tradable))
    throw new Error("None of the accepted issuer tokens is currently tradable");
}

/** JSON view of live legs for review responses. */
export const legView = (legs: Record<number, LiveLeg>) =>
  Object.fromEntries(
    Object.values(legs).map((l) => [
      l.collateral,
      {
        mint: l.mint,
        tradable: l.tradable,
        halt: l.halt,
        multiplier: l.multiplier.toString(),
        multiplierValue: l.multiplierValue,
      },
    ]),
  );

const FIT_FAILURE = /account limit|packet limit|compute budget exceeds/;

/** Plans against the live confirmed index (`read`). Issuer leg state comes from
 * the same streamed snapshot; `readLegs` (RPC) is only a fallback for a
 * snapshot without live leg state. */
export function createOrderPlan(
  client: SolanaClient,
  read: () => Snapshot | Promise<Snapshot>,
  readLegs: LegReader = (market) =>
    liveLegs(client.connection, market, client.config, client.program),
) {
  /** `prefix` instructions share the placement transaction (e.g. a wallet
   * initializer) and count toward its account and packet budget. */
  return async (order: OrderWire, snapshot?: Snapshot, prefix: TransactionInstruction[] = []) => {
    const s = snapshot ?? (await read()),
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
    assertOrderLegs(order, m);
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
    // Live issuer state (pause, vault freeze, multiplier band) decides which
    // legs can deliver; indexed reservations decide which asks still cover it.
    // Streamed issuer state (no RPC round trip); RPC only if the snapshot has none.
    const legs = s.legs?.get(order.marketId) ?? (await readLegs(m));
    assertOrderLegs(order, m, legs);
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
        reserved: big(o.reserved),
      }));
    const nextSequence = m.sequence[order.branch];
    if (!nextSequence) throw new Error("Market branch sequence is unavailable");
    const payer = key(order.delegate ?? order.maker);
    // Multi-leg fills need 7 accounts per touched issuer leg. When a plan does
    // not fit one transaction, retry with fewer makers; never silently split a
    // reviewed order across transactions.
    let maxMakers = MAX_MAKERS,
      plan: AtomicPlan;
    for (;;) {
      try {
        plan = planOrder({
          program: client.program,
          order,
          candidates,
          now,
          step: big(m.terms.step),
          nextSequence: big(nextSequence),
          makerFeeBps: s.config.maker_bps,
          takerFeeBps: s.config.taker_bps,
          legs,
          maxMakers,
        });
      } catch (error) {
        if (maxMakers < MAX_MAKERS && error instanceof Error && /crosses more than/.test(error.message))
          throw new Error(
            `This order crosses more makers than fit in one transaction (at most ${maxMakers} here); reduce quantity`,
          );
        throw error;
      }
      try {
        await client.assertTransactionFits(
          payer,
          envelope([...prefix, client.placement(order, plan, m)], client.program),
        );
        break;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !FIT_FAILURE.test(error.message) ||
          plan.makers.length <= 1
        )
          throw error;
        maxMakers = plan.makers.length - 1;
      }
    }
    return {
      orderHash: orderId(order, client.program),
      order,
      notional: notional.toString(),
      plan,
      legs: legView(legs),
      // The keeper tables this plan was sized with; the wallet compiles with the same set.
      lookupTables: client.keeperLookupTableAddresses(),
      snapshotSlot: s.slot,
      atomicRouter: client.program.toBase58(),
      executionVersion: 1,
    };
  };
}
