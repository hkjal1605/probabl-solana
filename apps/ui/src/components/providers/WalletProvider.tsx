"use client";
import { SolanaClient } from "@conditional-stocks/solana-client";
import { clearWalletStores } from "@/stores/createResourceStore";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { protocolConfig } from "@/config/protocol";
import { requestJson } from "@/services/protocol-api-service";
import { createWalletController, type WalletState } from "@/lib/wallet/controller";
import { browserStorage } from "@/lib/wallet/session";

type WalletController = ReturnType<typeof createWalletController>;
type WalletValue = WalletState &
  Pick<
    WalletController,
    | "connect"
    | "disconnect"
    | "ensureNetwork"
    | "authenticate"
    | "invalidateSession"
    | "sendTransaction"
  >;
const Context = createContext<WalletValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [controller] = useState(() =>
    createWalletController({
      deployment: protocolConfig,
      sources: () => window,
      storage: browserStorage,
      origin: () => window.location.origin,
      client: () => new SolanaClient(protocolConfig),
      request: requestJson,
      clearCache: clearWalletStores,
    }),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getServerSnapshot,
  );
  useEffect(() => {
    controller.start({ window, document });
    return controller.stop;
  }, [controller]);
  return (
    <Context.Provider
      value={{
        ...state,
        connect: controller.connect,
        disconnect: controller.disconnect,
        ensureNetwork: controller.ensureNetwork,
        authenticate: controller.authenticate,
        invalidateSession: controller.invalidateSession,
        sendTransaction: controller.sendTransaction,
      }}
    >
      {children}
    </Context.Provider>
  );
}

export function useWallet() {
  const value = useContext(Context);
  if (!value) throw new Error("WalletProvider is required");
  return value;
}
