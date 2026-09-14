import { assertSignInChallenge, type SolanaClient } from "@conditional-stocks/solana-client";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { Buffer } from "buffer";
import { connectWallet, findWallet, type WalletHandle, type WalletSources } from "./injected";
import {
  assertRequestSession,
  createWalletSession,
  forget,
  persistWalletSession,
  rememberedWallet,
  rememberWallet,
  type SavedWalletSession,
  SESSION_EXPIRED_EVENT,
  SESSION_STORAGE_KEY,
  type SessionStorage,
  savedWalletSession,
  sessionBinding,
  setRequestSession,
  WALLET_STORAGE_KEY,
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
  deployment: { programId: string; config: string; genesisHash: string; chainId: number };
  sources(): WalletSources;
  storage(): SessionStorage | null;
  origin(): string;
  client(): Pick<SolanaClient, "assertNetwork" | "prepareTransaction" | "connection">;
  request<T>(path: string, options: { body: unknown }): Promise<T>;
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

/** One controller per mounted provider. No wallet/session state is created during SSR. */
export function createWalletController(deps: Dependencies) {
  let state = initialState;
  let session: SavedWalletSession | null = null;
  let selected: WalletHandle | null = null;
  let generation = 0,
    networkRequest = 0,
    operationId = 0;
  let pending: number | null = null;
  let connecting = false,
    mounted = false;
  let cleanupProvider = () => {};
  let cleanupLifecycle = () => {};
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<WalletState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const binding = () => sessionBinding(deps.deployment, deps.origin());
  const currentWallet = () => {
    if (!selected || findWallet(deps.sources(), selected.kind)?.provider !== selected.provider)
      throw new Error("Wallet is unavailable. Connect again.");
    return selected.provider;
  };
  const activate = (value: SavedWalletSession | null) => {
    session = value;
    setRequestSession(
      value,
      value
        ? () => {
            if (
              !mounted ||
              state.account !== value.owner ||
              currentWallet().publicKey?.toBase58() !== value.owner
            )
              throw new Error("Wallet changed. Review the action again.");
          }
        : undefined,
    );
    clearTimeout(expiryTimer);
    scheduleExpiry();
    publish({ sessionToken: value?.token ?? null, sessionExpiresAt: value?.expiresAt ?? null });
  };
  const clearSession = (forgetSaved = true) => {
    activate(null);
    deps.clearCache();
    if (forgetSaved) forget(deps.storage(), SESSION_STORAGE_KEY);
  };
  const invalidateSession = (expectedToken?: string) => {
    if (expectedToken !== undefined && session?.token !== expectedToken) return;
    generation++;
    clearSession();
  };
  function expireIfNeeded() {
    if (session && (Date.now() < session.issuedAt || Date.now() >= session.expiresAt))
      invalidateSession(session.token);
  }
  function scheduleExpiry() {
    if (!session) return;
    // Browser timers overflow beyond ~24.8 days. Re-arm until the absolute expiry.
    expiryTimer = setTimeout(() => {
      expireIfNeeded();
      scheduleExpiry();
    }, Math.min(2_147_483_647, Math.max(0, session.expiresAt - Date.now())));
  }
  const dropConnection = (forgetSaved = true) => {
    generation++;
    networkRequest++;
    cleanupProvider();
    cleanupProvider = () => {};
    selected = null;
    publish({ account: null, chainId: null, status: "idle", error: null });
    clearSession(forgetSaved);
    if (forgetSaved) forget(deps.storage(), WALLET_STORAGE_KEY);
  };
  const remember = (handle: WalletHandle, owner: string) => {
    if (!rememberWallet(deps.storage(), handle.kind, owner))
      publish({
        persistenceError:
          "Browser storage is unavailable. You may need to reconnect after refresh.",
      });
  };
  const capture = () => {
    expireIfNeeded();
    const revision = generation,
      owner = state.account,
      token = session?.token ?? null;
    if (!owner) throw new Error("Connect a wallet first.");
    const check = () => {
      expireIfNeeded();
      if (
        !mounted ||
        revision !== generation ||
        state.account !== owner ||
        currentWallet().publicKey?.toBase58() !== owner ||
        (session?.token ?? null) !== token
      )
        throw new Error("Wallet or session changed. Review the action again.");
      if (token) assertRequestSession(token);
    };
    check();
    return check;
  };
  const begin = () => {
    if (!mounted) throw new Error("Wallet connection is not ready.");
    if (pending !== null) throw new Error("A wallet request is already in progress.");
    pending = ++operationId;
    return pending;
  };
  const finish = (id: number) => {
    if (pending !== id) return;
    pending = null;
    connecting = false;
    publish({ status: state.account ? "connected" : "idle" });
  };
  const verifyNetwork = async () => {
    const owner = state.account,
      revision = generation,
      request = ++networkRequest;
    if (!owner) throw new Error("Connect a wallet first.");
    const current = () => mounted && request === networkRequest && revision === generation;
    publish({ chainId: null, error: null });
    try {
      await deps.client().assertNetwork();
      if (!current() || currentWallet().publicKey?.toBase58() !== owner)
        throw new Error("Wallet changed during network verification. Connect again.");
      publish({ chainId: deps.deployment.chainId });
    } catch (error) {
      if (current())
        publish({ error: error instanceof Error ? error.message : "Network verification failed." });
      throw error;
    }
  };
  const restoreSession = () => {
    if (session || !state.account || currentWallet().publicKey?.toBase58() !== state.account)
      return;
    const saved = savedWalletSession(deps.storage(), binding(), state.account);
    if (saved) activate(saved); // Keep the original absolute expiry; refresh is not a new sign-in.
  };
  const ensureNetwork = async () => {
    expireIfNeeded();
    await verifyNetwork();
    restoreSession();
  };
  const attach = (handle: WalletHandle) => {
    if (selected?.provider === handle.provider) return;
    cleanupProvider();
    selected = handle;
    const p = handle.provider;
    const changed = () => {
      const owner = p.publicKey?.toBase58() ?? null;
      if ((!state.account && connecting) || owner === state.account) return;
      if (!owner) {
        dropConnection();
        return;
      }
      generation++;
      networkRequest++;
      clearSession();
      publish({ account: owner, chainId: null, status: "connected" });
      remember(handle, owner);
      const verifyChangedWallet = async () => {
        try {
          await verifyNetwork();
        } catch {
          /* The network error is already visible. */
        }
      };
      void verifyChangedWallet();
    };
    const disconnected = () => dropConnection();
    p.on?.("accountChanged", changed);
    p.on?.("disconnect", disconnected);
    cleanupProvider = () => {
      p.removeListener?.("accountChanged", changed);
      p.removeListener?.("disconnect", disconnected);
    };
  };
  const establish = async (handle: WalletHandle, silent: boolean) => {
    const id = begin(),
      revision = generation;
    connecting = true;
    publish({ status: "connecting", error: null, persistenceError: null });
    attach(handle);
    try {
      const owner = await connectWallet(handle, silent);
      if (!mounted || revision !== generation) throw new Error("Wallet changed during connection.");
      const previous = rememberedWallet(deps.storage());
      clearSession(
        Boolean(previous && (previous.owner !== owner || previous.kind !== handle.kind)),
      );
      generation++;
      publish({ account: owner });
      remember(handle, owner);
      await ensureNetwork();
    } catch (error) {
      if (mounted && !silent && pending === id)
        publish({ error: error instanceof Error ? error.message : "Wallet connection failed." });
      throw error;
    } finally {
      finish(id);
    }
  };
  const connect = async () => {
    const saved = rememberedWallet(deps.storage());
    const handle = (saved && findWallet(deps.sources(), saved.kind)) || findWallet(deps.sources());
    if (!handle) throw new Error("Open a Solana wallet such as Phantom or Solflare.");
    await establish(handle, false);
  };
  const disconnect = () => {
    const p = selected?.provider;
    dropConnection();
    const disconnectProvider = async () => {
      try {
        await p?.disconnect();
      } catch {
        /* Local logout succeeds even if the extension fails. */
      }
    };
    void disconnectProvider();
  };
  const authenticate = async () => {
    const check = capture();
    const owner = state.account;
    if (!owner) throw new Error("Connect a wallet first.");
    const id = begin();
    publish({ status: "signing" });
    try {
      await verifyNetwork();
      check();
      if (session) return session.token;
      const challenge = await deps.request<{ challengeId: string; message: string }>(
        "/v1/auth/challenge",
        { body: { address: owner, origin: deps.origin() } },
      );
      assertSignInChallenge(challenge, owner, deps.deployment, deps.origin());
      check();
      const signed = await currentWallet().signMessage(
        new TextEncoder().encode(challenge.message),
        "utf8",
      );
      check();
      const issuedAt = Date.now();
      const result = await deps.request<{ token: string; expiresAtMs?: unknown }>(
        "/v1/auth/verify",
        {
          body: {
            address: owner,
            challengeId: challenge.challengeId,
            signature: bs58.encode(signed.signature),
          },
        },
      );
      check();
      const value = createWalletSession(
        binding(),
        owner,
        result.token,
        issuedAt,
        result.expiresAtMs,
      );
      if (value.expiresAt <= Date.now()) throw new Error("Trading session expired. Sign in again.");
      activate(value);
      if (!persistWalletSession(deps.storage(), value))
        publish({
          persistenceError:
            "Browser storage is unavailable. This sign-in cannot survive a refresh.",
        });
      return value.token;
    } finally {
      finish(id);
    }
  };
  const sendTransaction = async (value: { to: string; data: string; value?: string }) => {
    if (value.value !== undefined && value.value !== "0")
      throw new Error("Invalid transaction value.");
    const check = capture();
    if (!state.account) throw new Error("Connect a wallet first.");
    const owner = new PublicKey(state.account),
      id = begin();
    publish({ status: "signing" });
    try {
      const client = deps.client();
      const built = await client.prepareTransaction(
        owner,
        { ...value, value: "0" },
        { pinWalletFees: true },
      );
      check();
      const original = Buffer.from(built.transaction.message.serialize());
      const signed = await currentWallet().signTransaction(built.transaction);
      check();
      if (!Buffer.from(signed.message.serialize()).equals(original))
        throw new Error(
          "Wallet changed the reviewed transaction. No transaction was sent. " +
            "Keep the app-provided network fee settings, then review and sign again.",
        );
      const signature = await client.connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        maxRetries: 2,
      });
      const confirmed = await client.connection.confirmTransaction(
        {
          signature,
          blockhash: built.blockhash,
          lastValidBlockHeight: built.lastValidBlockHeight,
        },
        "confirmed",
      );
      if (confirmed.value.err)
        throw new Error("Transaction failed. Its state changes were rolled back.");
      return signature;
    } finally {
      finish(id);
    }
  };
  const start = (events: { window: EventTarget; document: EventTarget }) => {
    mounted = true;
    publish({ restoring: true });
    const started = Date.now();
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const restore = async () => {
      if (disposed) return;
      const saved = rememberedWallet(deps.storage());
      if (!saved) {
        publish({ restoring: false });
        return;
      }
      const handle = findWallet(deps.sources(), saved.kind);
      if (!handle && Date.now() - started < 10_000) {
        timer = setTimeout(() => void restore(), 250);
        return;
      }
      try {
        if (handle) await establish(handle, true);
      } catch {
        /* Locked/revoked wallets need a manual connection, never an automatic popup. */
      } finally {
        if (!disposed) publish({ restoring: false });
      }
    };
    const expired = (event: Event) => {
      const token = (event as CustomEvent<unknown>).detail;
      if (typeof token === "string") invalidateSession(token);
    };
    const storageChanged = (event: Event) => {
      const e = event as StorageEvent;
      if (e.storageArea && e.storageArea !== deps.storage()) return;
      if (e.key === null || e.key === WALLET_STORAGE_KEY) {
        const saved = rememberedWallet(deps.storage());
        if (!saved || (selected && (saved.owner !== state.account || saved.kind !== selected.kind)))
          dropConnection(false);
      }
      if (e.key === null || e.key === SESSION_STORAGE_KEY) {
        if (
          (session &&
            savedWalletSession(deps.storage(), binding(), session.owner)?.token !==
              session.token) ||
          (!session && pending !== null)
        ) {
          generation++;
          clearSession(false);
        }
      }
    };
    events.window.addEventListener(SESSION_EXPIRED_EVENT, expired);
    events.window.addEventListener("storage", storageChanged);
    events.window.addEventListener("focus", expireIfNeeded);
    events.document.addEventListener("visibilitychange", expireIfNeeded);
    // Defer until after React StrictMode's immediate effect setup/cleanup.
    timer = setTimeout(() => void restore(), 0);
    cleanupLifecycle = () => {
      disposed = true;
      clearTimeout(timer);
      events.window.removeEventListener(SESSION_EXPIRED_EVENT, expired);
      events.window.removeEventListener("storage", storageChanged);
      events.window.removeEventListener("focus", expireIfNeeded);
      events.document.removeEventListener("visibilitychange", expireIfNeeded);
    };
  };
  const stop = () => {
    mounted = false;
    generation++;
    networkRequest++;
    pending = null;
    connecting = false;
    cleanupLifecycle();
    cleanupProvider();
    cleanupProvider = () => {};
    selected = null;
    clearTimeout(expiryTimer);
    session = null;
    setRequestSession(null);
    state = initialState;
  };
  return {
    getSnapshot: () => state,
    getServerSnapshot: () => initialState,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    stop,
    connect,
    disconnect,
    ensureNetwork,
    authenticate,
    invalidateSession,
    sendTransaction,
  };
}
