"use client";
import { useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { indexStreamHealthy, parseIndexUpdate, parseStreamWallet, setIndexStreamHealthy } from "@/lib/api/index-stream";
import { useWallet } from "./WalletProvider";

/** One stream per app, shared by every mounted query. Reconnect always resnapshots. */
export function IndexStreamProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const { account } = useWallet();
  useEffect(() => {
    const stream = new EventSource(`/api/stream${account ? `?owner=${encodeURIComponent(account)}` : ""}`);
    let slot = -1;
    let wasHealthy = false;
    const watchdog = setInterval(() => {
      if (wasHealthy && !indexStreamHealthy()) {
        wasHealthy = false;
        void client.invalidateQueries({ predicate: (q) => ["markets", "wallet-orders", "trades", "positions", "whole-balances", "trading-readiness"].includes(String(q.queryKey[0])) });
      }
    }, 2000);
    const receive = (event: MessageEvent, reset: boolean) => {
      try {
        const update = parseIndexUpdate(event.data);
        if (update.slot < slot && !reset) throw new Error("Index stream moved backwards");
        slot = update.slot;
        setIndexStreamHealthy(Date.now() + 10_000);
        wasHealthy = true;
        const wallet = update.wallet && account ? parseStreamWallet(update.wallet, account) : undefined;
        for (const query of client.getQueryCache().getAll()) {
          const [kind, key] = query.queryKey;
          const indexed = ["markets", "wallet-orders", "trades", "positions", "whole-balances", "trading-readiness"].includes(String(kind));
          if (!indexed || !query.isActive()) continue;
          if (kind === "trading-readiness" && update.readiness[String(key)]) {
            client.setQueryData(query.queryKey, update.readiness[String(key)]);
            continue;
          }
          if (wallet && key === account && kind === "positions") {
            client.setQueryData(query.queryKey, { positions: wallet.positions, observedAt: wallet.observedAt, blockNumber: wallet.blockNumber });
            continue;
          }
          if (wallet && key === account && kind === "whole-balances") {
            const balance = wallet.balances[String(query.queryKey.at(-1))];
            if (balance) client.setQueryData(query.queryKey, { ...balance, observedAt: wallet.observedAt });
            continue;
          }
          if (["positions", "whole-balances"].includes(String(kind)) && !reset) continue;
          const changed = reset ||
            (kind === "markets" && update.markets.some((m) => query.queryKey.at(-1) === "all" || query.queryKey.at(-1) === m)) ||
            (["trades", "trading-readiness"].includes(String(kind)) && update.markets.includes(String(key))) ||
            (["wallet-orders", "positions", "whole-balances"].includes(String(kind)) && update.owners.includes(String(key)));
          if (changed) void client.invalidateQueries({ queryKey: query.queryKey, exact: true }, { cancelRefetch: false });
          else if (query.state.data !== undefined && !query.state.isInvalidated && query.state.status === "success" &&
            !["positions", "whole-balances", "trading-readiness"].includes(String(kind)))
            client.setQueryData(query.queryKey, query.state.data);
        }
      } catch { setIndexStreamHealthy(0); }
    };
    stream.addEventListener("index", (e) => receive(e as MessageEvent, false));
    stream.addEventListener("reset", (e) => receive(e as MessageEvent, true));
    stream.addEventListener("unavailable", () => setIndexStreamHealthy(0));
    stream.onerror = () => setIndexStreamHealthy(0);
    return () => { clearInterval(watchdog); stream.close(); setIndexStreamHealthy(0); };
  }, [client, account]);
  return children;
}
