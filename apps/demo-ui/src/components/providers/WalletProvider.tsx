"use client";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { protocolConfig } from "@/config/protocol";
import { createWalletController, type WalletState } from "@/lib/wallet/controller";
import { clearWalletStores } from "@/stores/createResourceStore";

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
    createWalletController({ deployment: protocolConfig, clearCache: clearWalletStores }),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getServerSnapshot,
  );
  useEffect(() => {
    controller.start();
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
