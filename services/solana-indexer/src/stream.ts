import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Snapshot } from "./projection";
import { marketView } from "./projection";
import type { WalletIndex } from "./wallet-index";

export interface IndexUpdate {
  slot: number;
  observedAt: number;
  markets: string[];
  owners: string[];
}

export function changedTopics(previous: Snapshot | undefined, next: Snapshot): IndexUpdate {
  const before = new Map(previous?.rawAccounts?.map((a) => [a.address, a.data]));
  const after = new Map(next.rawAccounts?.map((a) => [a.address, a.data]));
  const markets = new Set<string>(), owners = new Set<string>();
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(id) === after.get(id)) continue;
    if (![previous, next].some((s) => s && (s.markets.has(id) || s.orders.has(id) || s.wallets.has(id))))
      for (const market of next.markets.keys()) markets.add(market);
    for (const s of [previous, next]) {
      if (!s) continue;
      if (s.markets.has(id)) {
        const beforeMarket = previous?.markets.get(id), afterMarket = next.markets.get(id);
        if (!beforeMarket || !afterMarket ||
          JSON.stringify(marketView(id, beforeMarket)) !== JSON.stringify(marketView(id, afterMarket)))
          markets.add(id);
      }
      const order = s.orders.get(id);
      if (order) { markets.add(order.market.toBase58()); owners.add(order.owner.toBase58()); }
      const wallet = s.wallets.get(id);
      if (wallet) owners.add(wallet.owner.toBase58());
    }
  }
  return { slot: next.slot, observedAt: next.observedAt, markets: [...markets], owners: [...owners] };
}

/** One broadcaster per indexer, never one RPC/DB loop per connected browser. */
export function createIndexStream() {
  const listeners = new Set<(value: IndexUpdate) => void>();
  return {
    publish(value: IndexUpdate) { for (const listener of listeners) listener(value); },
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
          const listener = (value: IndexUpdate) => {
            // Bounded coalescing: slow clients get one complete invalidation set,
            // not an unbounded queue of every intermediate indexer tick.
            pending = pending ? { ...value,
              markets: [...new Set([...pending.markets, ...value.markets])],
              owners: [...new Set([...pending.owners, ...value.owners])],
            } : value;
          };
          listeners.add(listener);
          stream.onAbort(() => { listeners.delete(listener); });
          try {
            while (!stream.aborted) {
              try {
                const s = state();
                if (owner) wallets?.touch(owner);
                const wallet = owner ? wallets?.peek(owner) : undefined;
                if (owner && !wallet) void wallets?.get(owner).catch(() => {});
                const value = { ...(pending ?? { slot: s.slot, observedAt: s.observedAt, markets: [], owners: [] }),
                  wallet: wallet && wallet.observedAt !== walletStamp ? wallet : undefined,
                  readiness: Object.fromEntries([...s.markets].map(([id, m]) => {
                    const now = BigInt(Math.floor(Date.now() / 1000));
                    const reason = s.config.paused ? "paused" : m.state !== 2 ? m.state === 1 ? "scheduled" : "closed"
                      : BigInt(m.terms.trading_cutoff.toString()) <= now ? "closed"
                      : BigInt(m.terms.trading_open.toString()) > now ? "scheduled" : "ready";
                    return [id, { healthy: reason === "ready", reason, checkedAt: s.observedAt, chain: "solana" }];
                  })),
                };
                walletStamp = wallet?.observedAt ?? walletStamp;
                pending = undefined;
                await stream.writeSSE({ event: reset ? "reset" : "index", id: String(s.slot), data: JSON.stringify(value) });
                reset = false;
              } catch {
                await stream.writeSSE({ event: "unavailable", data: "{}" });
                reset = true;
              }
              await stream.sleep(2000);
            }
          } finally { listeners.delete(listener); }
        });
      });
    },
  };
}
