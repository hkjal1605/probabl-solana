import type { ProtocolTransaction } from "@/lib/trading/transaction";
import {
  connect as connectAccount,
  disconnect as disconnectAccount,
  isConnected,
} from "@/protocol/engine";
import {
  createWalletSession,
  type SavedWalletSession,
  setRequestSession,
  type WalletKind,
} from "./session";

export interface WalletState {
  account: string | null;
  chainId: number | null;
  sessionToken: string | null;
  sessionExpiresAt: number | null;
  error: string | null;
  persistenceError: string | null;
  restoring: boolean;
  status: "idle" | "connecting" | "connected" | "signing" | "error";
}

interface Dependencies {
  deployment: { chainId: number };
  clearCache(): void;
}

const initialState: WalletState = {
  account: null,
  chainId: null,
  sessionToken: null,
  sessionExpiresAt: null,
  error: null,
  persistenceError: null,
  restoring: true,
  status: "idle",
};

const settle = <T>(value: T, delay: number): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), delay));

/** One controller per mounted provider. No wallet state is created during SSR. */
export function createWalletController(deps: Dependencies) {
  let state = initialState;
  let session: SavedWalletSession | null = null;
  let mounted = false;
  let pending = false;
  const listeners = new Set<() => void>();

  const publish = (patch: Partial<WalletState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  const activate = (value: SavedWalletSession | null) => {
    session = value;
    setRequestSession(value);
    publish({ sessionToken: value?.token ?? null, sessionExpiresAt: value?.expiresAt ?? null });
  };

  const establish = async () => {
    if (pending) throw new Error("A wallet request is already in progress.");
    pending = true;
    publish({ status: "connecting", error: null });
    try {
      const account = await settle(connectAccount(), 320);
      if (!mounted) return;
      publish({ account, chainId: deps.deployment.chainId, status: "connected" });
    } finally {
      pending = false;
      if (mounted && state.status === "connecting")
        publish({ status: state.account ? "connected" : "idle" });
    }
  };

  const connect = async (_kind?: WalletKind) => {
    await establish();
  };

  const disconnect = () => {
    disconnectAccount();
    activate(null);
    deps.clearCache();
    publish({ account: null, chainId: null, status: "idle", error: null });
  };

  const ensureNetwork = async () => {
    if (!state.account) throw new Error("Connect a wallet first.");
    publish({ chainId: deps.deployment.chainId, error: null });
  };

  const authenticate = async () => {
    const account = state.account;
    if (!account) throw new Error("Connect a wallet first.");
    if (session) return session.token;
    publish({ status: "signing" });
    try {
      const value = await settle(createWalletSession(account), 280);
      activate(value);
      return value.token;
    } finally {
      if (mounted) publish({ status: state.account ? "connected" : "idle" });
    }
  };

  const invalidateSession = (expectedToken?: string) => {
    if (expectedToken !== undefined && session?.token !== expectedToken) return;
    activate(null);
  };

  /** Signs and confirms a locally built protocol transaction. */
  const sendTransaction = async (transaction: ProtocolTransaction) => {
    if (!state.account) throw new Error("Connect a wallet first.");
    if (pending) throw new Error("A wallet request is already in progress.");
    pending = true;
    publish({ status: "signing" });
    try {
      await settle(null, 420);
      return transaction.execute();
    } finally {
      pending = false;
      if (mounted) publish({ status: state.account ? "connected" : "idle" });
    }
  };

  const start = () => {
    mounted = true;
    publish({ restoring: true });
    const timer = setTimeout(() => {
      if (!mounted) return;
      if (isConnected())
        publish({
          account: connectAccount(),
          chainId: deps.deployment.chainId,
          status: "connected",
        });
      publish({ restoring: false });
    }, 0);
    return () => clearTimeout(timer);
  };

  let cleanup = () => {};
  return {
    getSnapshot: () => state,
    getServerSnapshot: () => initialState,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: () => {
      cleanup = start();
    },
    stop: () => {
      mounted = false;
      pending = false;
      cleanup();
      session = null;
      setRequestSession(null);
      state = initialState;
    },
    connect,
    disconnect,
    ensureNetwork,
    authenticate,
    invalidateSession,
    sendTransaction,
  };
}
