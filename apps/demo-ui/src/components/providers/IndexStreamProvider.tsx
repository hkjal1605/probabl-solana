"use client";
import { type ReactNode, useEffect } from "react";
import { subscribe, walletSnapshot } from "@/protocol/engine";
import { setIndexStreamHealthy } from "@/services/index-stream";
import { resources } from "@/stores/createResourceStore";
import { useWallet } from "./WalletProvider";

/** Pushes each protocol tick into the shared resource stores, so views stay live. */
const IndexStreamProvider = ({ children }: { children: ReactNode }) => {
  const { account } = useWallet();
  useEffect(() => {
    const stop = subscribe(() => {
      setIndexStreamHealthy(Date.now() + 10_000);
      const wallet = account ? walletSnapshot() : undefined;
      for (const [name, resource] of resources) {
        if (name === "spot-prices") continue;
        for (const [key, active] of resource.active) {
          if (name === "positions") {
            if (wallet && key === account) resource.setData(key, wallet, wallet.observedAt);
            continue;
          }
          void active.refresh();
        }
      }
    });
    return () => {
      stop();
      setIndexStreamHealthy(0);
    };
  }, [account]);
  return children;
};

export { IndexStreamProvider };
export default IndexStreamProvider;
