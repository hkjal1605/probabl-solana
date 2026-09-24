import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { type MarketAccount, underlyingAsset } from "@conditional-stocks/solana-client";
import type { Snapshot } from "./projection";
import { marketView } from "./projection";
import type { WalletIndex } from "./wallet-index";

/** Base-leg lifecycle as a market update: a listing (program `Change` kind 15,
 * amount = scale) or a delist/relist (kind 16, amount 0/1). */
export type MarketEvent =
  | { marketId: string; kind: "base-listed"; collateral: number; mint: string | null; scale: string }
  | { marketId: string; kind: "base-active"; collateral: number; active: boolean };

export interface IndexUpdate {
  slot: number;
  observedAt: number;
  markets: string[];
  owners: string[];
  /** Leg listings and active toggles observed between the two snapshots. */
  marketEvents: MarketEvent[];
}
const MAX_STREAM_EVENTS = 64;

/** A finalized `Change` event of kind 15/16 in the indexed JSON shape. */
export function legEvent(
  signature: string,
  index: number,
  blockTime: string | number,
  data: Record<string, unknown>,
) {
  const kind = Number(data.kind),
    collateral = Number(data.asset),
    amount = String(data.amount);
  const common = {
    id: signature + ":" + index,
    marketId: String(data.market),
    collateral,
    blockTimestamp: String(blockTime),
    transactionHash: signature,
    confirmation: "finalized" as const,
  };
  if (kind === 15) return { ...common, kind: "base-listed" as const, scale: amount };
  if (kind === 16) return { ...common, kind: "base-active" as const, active: amount !== "0" };
  throw new Error("Not a base-leg change event");
}

/** Leg listings/toggles between two program images of one market. */
function legChanges(id: string, before: MarketAccount | undefined, after: MarketAccount) {
  const events: MarketEvent[] = [];
  if (!before) return events;
  for (let c = 1; c <= after.bases; c++) {
    const leg = after.legs[c - 1]!;
    if (c > before.bases)
      events.push({
        marketId: id,
        kind: "base-listed",
        collateral: c,
        mint: after.mints[underlyingAsset(c)]?.toBase58() ?? null,
        scale: leg.scale.toString(),
      });
    else if (before.legs[c - 1]!.active !== leg.active)
      events.push({ marketId: id, kind: "base-active", collateral: c, active: leg.active });
  }
  return events;
}

/** Topics invalidated between two snapshots. `changed` is the exact set of
 * changed account addresses when the caller knows it (live stream commits);
 * otherwise raw account images are compared. */
export function changedTopics(
  previous: Snapshot | undefined,
  next: Snapshot,
  changed?: ReadonlySet<string>,
): IndexUpdate {
  const markets = new Set<string>(),
    owners = new Set<string>(),
    marketEvents: MarketEvent[] = [];
  let addresses: Iterable<string>;
  if (changed) addresses = changed;
  else {
    const before = new Map(previous?.rawAccounts?.map((a) => [a.address, a.data]));
    const after = new Map(next.rawAccounts?.map((a) => [a.address, a.data]));
    addresses = [...new Set([...before.keys(), ...after.keys()])].filter((id) => before.get(id) !== after.get(id));
  }
  for (const id of addresses) {
    if (
      ![previous, next].some(
        (s) =>
          s &&
          (s.markets.has(id) ||
            s.orders.has(id) ||
            s.wallets.has(id) ||
            s.pools?.has(id) ||
            s.credits?.has(id)),
      )
    )
      for (const market of next.markets.keys()) markets.add(market);
    const afterMarket = next.markets.get(id);
    if (afterMarket) marketEvents.push(...legChanges(id, previous?.markets.get(id), afterMarket));
    for (const s of [previous, next]) {
      if (!s) continue;
      if (s.markets.has(id)) {
        const beforeMarket = previous?.markets.get(id);
        if (
          !beforeMarket ||
          !afterMarket ||
          JSON.stringify(marketView(id, beforeMarket)) !==
            JSON.stringify(marketView(id, afterMarket))
        )
          markets.add(id);
      }
      const order = s.orders.get(id);
      if (order) {
        markets.add(order.market.toBase58());
        owners.add(order.owner.toBase58());
      }
      const wallet = s.wallets.get(id);
      if (wallet) owners.add(wallet.owner.toBase58());
      const credit = s.credits?.get(id);
      if (credit) owners.add(credit.owner.toBase58());
    }
  }
  // Live issuer state changes (pause, freeze, multiplier) also invalidate the
  // market view even when no program account changed.
  for (const [id, market] of next.markets) {
    const before = previous?.legs?.get(id),
      after = next.legs?.get(id);
    if (
      previous?.markets.has(id) &&
      JSON.stringify(marketView(id, market, undefined, before)) !==
        JSON.stringify(marketView(id, market, undefined, after))
    )
      markets.add(id);
  }
  return {
    slot: next.slot,
    observedAt: next.observedAt,
    markets: [...markets],
    owners: [...owners],
    marketEvents: marketEvents.slice(-MAX_STREAM_EVENTS),
  };
}

/** One broadcaster per indexer, never one RPC/DB loop per connected browser. */
export function createIndexStream() {
  const listeners = new Set<(value: IndexUpdate) => void>();
  return {
    publish(value: IndexUpdate) {
      for (const listener of listeners) listener(value);
    },
    mount(app: Hono, state: () => Snapshot, wallets?: WalletIndex) {
      app.get("/stream", (c) => {
        const owner = c.req.query("owner");
        if (owner) wallets?.touch(owner);
        if (listeners.size >= 2000) return c.json({ error: "Stream capacity reached" }, 503);
        c.header("X-Accel-Buffering", "no");
        c.header("Cache-Control", "no-cache, no-transform");
        return streamSSE(c, async (stream) => {
          let pending: IndexUpdate | undefined;
          let reset = true;
          let walletStamp = 0;
          let wake: (() => void) | undefined;
          const listener = (value: IndexUpdate) => {
            // Bounded coalescing: slow clients get one complete invalidation set,
            // not an unbounded queue of every intermediate indexer tick.
            pending = pending
              ? {
                  ...value,
                  markets: [...new Set([...pending.markets, ...value.markets])],
                  owners: [...new Set([...pending.owners, ...value.owners])],
                  marketEvents: [...pending.marketEvents, ...value.marketEvents].slice(
                    -MAX_STREAM_EVENTS,
                  ),
                }
              : value;
            // Push as soon as a slot commits, not on a polling timer.
            wake?.();
          };
          listeners.add(listener);
          stream.onAbort(() => {
            listeners.delete(listener);
          });
          try {
            while (!stream.aborted) {
              try {
                const s = state();
                if (owner) wallets?.touch(owner);
                const wallet = owner ? wallets?.peek(owner) : undefined;
                if (owner && !wallet) void wallets?.get(owner).catch(() => {});
                const value = {
                  ...(pending ?? {
                    slot: s.slot,
                    observedAt: s.observedAt,
                    markets: [],
                    owners: [],
                    marketEvents: [],
                  }),
                  wallet: wallet && wallet.observedAt !== walletStamp ? wallet : undefined,
                  readiness: Object.fromEntries(
                    [...s.markets].map(([id, m]) => {
                      const now = BigInt(Math.floor(Date.now() / 1000));
                      const reason = s.config.paused
                        ? "paused"
                        : m.state !== 2
                          ? m.state === 1
                            ? "scheduled"
                            : "closed"
                          : BigInt(m.terms.trading_cutoff.toString()) <= now
                            ? "closed"
                            : BigInt(m.terms.trading_open.toString()) > now
                              ? "scheduled"
                              : "ready";
                      return [
                        id,
                        {
                          healthy: reason === "ready",
                          reason,
                          checkedAt: s.observedAt,
                          chain: "solana",
                        },
                      ];
                    }),
                  ),
                };
                walletStamp = wallet?.observedAt ?? walletStamp;
                pending = undefined;
                await stream.writeSSE({
                  event: reset ? "reset" : "index",
                  id: String(s.slot),
                  data: JSON.stringify(value),
                });
                reset = false;
              } catch {
                await stream.writeSSE({ event: "unavailable", data: "{}" });
                reset = true;
                // Retry promptly while the index recovers.
                await stream.sleep(1000);
                continue;
              }
              // Wait for the next commit, with a heartbeat for idle connections.
              await Promise.race([
                new Promise<void>((resolve) => {
                  wake = resolve;
                  if (pending) resolve();
                }),
                stream.sleep(15_000),
              ]);
              wake = undefined;
            }
          } finally {
            listeners.delete(listener);
          }
        });
      });
    },
  };
}
