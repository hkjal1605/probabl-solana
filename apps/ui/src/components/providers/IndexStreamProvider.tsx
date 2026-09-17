"use client";
import { type ReactNode, useEffect } from "react";
import { apiUrl } from "@/services/constants";
import {
  indexStreamHealthy,
  parseIndexUpdate,
  parseStreamWallet,
  setIndexStreamHealthy,
} from "@/services/index-stream";
import { refreshStores, resources } from "@/stores/createResourceStore";
import { useWallet } from "./WalletProvider";

const IndexStreamProvider = ({ children }: { children: ReactNode }) => {
  const { account } = useWallet();
  useEffect(() => {
    const stream = new EventSource(
      apiUrl(`/stream${account ? `?owner=${encodeURIComponent(account)}` : ""}`),
    );
    let slot = -1,
      wasHealthy = false,
      stopped = false;
    const watchdog = setInterval(() => {
      if (wasHealthy && !indexStreamHealthy()) {
        wasHealthy = false;
        void refreshStores(
          [...resources.keys()].filter((name) => !["spot-prices", "probability"].includes(name)),
        );
      }
    }, 2000);
    const receive = (event: MessageEvent, reset: boolean) => {
      if (stopped) return;
      try {
        const update = parseIndexUpdate(event.data);
        if (update.slot < slot && !reset) throw new Error("Index stream moved backwards");
        const wallet =
          update.wallet && account ? parseStreamWallet(update.wallet, account) : undefined;
        slot = update.slot;
        setIndexStreamHealthy(Date.now() + 10_000);
        wasHealthy = true;
        for (const [name, resource] of resources) {
          if (name === "spot-prices") continue;
          for (const [key, active] of resource.active) {
            if (name === "positions" && wallet && key === account) {
              resource.setData(key, wallet, wallet.observedAt);
              continue;
            }
            if (name === "trading-readiness" && update.readiness[key]) {
              resource.setData(key, update.readiness[key], update.observedAt);
              continue;
            }
            const changed =
              reset ||
              (name === "markets" && update.markets.some((m) => key === "all" || key === m)) ||
              (["trades", "resolution"].includes(name) &&
                (key === "all" ? update.markets.length > 0 : update.markets.includes(key))) ||
              (["wallet-orders", "payout-credits"].includes(name) && update.owners.includes(key));
            if (changed) void active.refresh();
            else if (!["positions", "trading-readiness"].includes(name)) {
              const entry = resource.get(key);
              if (entry.data !== undefined && !entry.error && !entry.loading)
                resource.patch(key, { updatedAt: update.observedAt });
            }
          }
        }
      } catch {
        setIndexStreamHealthy(0);
      }
    };
    stream.addEventListener("index", (e) => receive(e as MessageEvent, false));
    stream.addEventListener("reset", (e) => receive(e as MessageEvent, true));
    stream.addEventListener("unavailable", () => setIndexStreamHealthy(0));
    stream.onerror = () => setIndexStreamHealthy(0);
    return () => {
      stopped = true;
      clearInterval(watchdog);
      stream.close();
      setIndexStreamHealthy(0);
    };
  }, [account]);
  return children;
};

export { IndexStreamProvider };
export default IndexStreamProvider;
