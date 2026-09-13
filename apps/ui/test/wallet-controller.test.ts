import { afterEach, expect, test } from "bun:test";
import {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { requestJson } from "../src/lib/api/client";
import { createWalletController } from "../src/lib/wallet/controller";
import type { SolanaWallet, WalletSources } from "../src/lib/wallet/injected";
import {
  assertRequestSession,
  createWalletSession,
  persistWalletSession,
  rememberedWallet,
  rememberWallet,
  SESSION_EXPIRED_EVENT,
  SESSION_STORAGE_KEY,
  sessionBinding,
  WALLET_SESSION_MS,
  WALLET_STORAGE_KEY,
} from "../src/lib/wallet/session";

const owner = PublicKey.unique(),
  other = PublicKey.unique();
const deployment = {
  programId: PublicKey.unique().toBase58(),
  config: PublicKey.unique().toBase58(),
  genesisHash: "devnet",
  chainId: 1,
};
const origin = "http://localhost:3001",
  token = "a".repeat(64);
type Controller = ReturnType<typeof createWalletController>;
type Dependencies = Parameters<typeof createWalletController>[0];
const controllers: Controller[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
});
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
};
function setup(saved = false, shared = storage()) {
  const events = { window: new EventTarget(), document: new EventTarget() };
  const walletEvents = new EventTarget();
  const calls = {
    connect: [] as unknown[],
    signMessage: 0,
    signTransaction: 0,
    api: [] as string[],
    network: 0,
    broadcasts: 0,
    clears: 0,
  };
  const p: SolanaWallet = {
    publicKey: owner,
    connect: async (options) => {
      calls.connect.push(options);
      if (!p.publicKey) throw new Error("Wallet locked");
      return { publicKey: p.publicKey };
    },
    disconnect: async () => {},
    signMessage: async () => {
      calls.signMessage++;
      return { signature: new Uint8Array(64).fill(1) };
    },
    signTransaction: async (tx) => {
      calls.signTransaction++;
      return tx;
    },
    on: (event, handler) => walletEvents.addEventListener(event, handler),
    removeListener: (event, handler) => walletEvents.removeEventListener(event, handler),
  };
  const sources: WalletSources = { phantom: { solana: p } };
  const makeTransaction = () =>
    new VersionedTransaction(
      new TransactionMessage({
        payerKey: owner,
        recentBlockhash: PublicKey.unique().toBase58(),
        instructions: [SystemProgram.transfer({ fromPubkey: owner, toPubkey: other, lamports: 1 })],
      }).compileToV0Message(),
    );
  const client = {
    assertNetwork: async () => {
      calls.network++;
    },
    prepareTransaction: async () => {
      const transaction = makeTransaction();
      return {
        transaction,
        blockhash: transaction.message.recentBlockhash,
        lastValidBlockHeight: 100,
      };
    },
    connection: {
      sendRawTransaction: async () => {
        calls.broadcasts++;
        return "signature";
      },
      confirmTransaction: async () => ({ context: { slot: 1 }, value: { err: null } }),
    },
  };
  const deps: Dependencies = {
    deployment,
    sources: () => sources,
    storage: () => shared,
    origin: () => origin,
    client: () => client as unknown as ReturnType<Dependencies["client"]>,
    request: async <T>(path: string) => {
      calls.api.push(path);
      const nonce = "c".repeat(64);
      return (
        path.endsWith("challenge")
          ? {
              challengeId: nonce,
              message: [
                "Sign in to probabl",
                `Origin: ${origin}`,
                `Solana genesis: ${deployment.genesisHash}`,
                `Program: ${deployment.programId}`,
                `Config: ${deployment.config}`,
                `Wallet: ${p.publicKey}`,
                `Nonce: ${nonce}`,
                `Expires: ${new Date(Date.now() + 120_000).toISOString()}`,
              ].join("\n"),
            }
          : { token }
      ) as T;
    },
    clearCache: () => {
      calls.clears++;
    },
  };
  if (saved) {
    rememberWallet(shared, "phantom", owner.toBase58());
    persistWalletSession(
      shared,
      createWalletSession(sessionBinding(deployment, origin), owner.toBase58(), token),
    );
  }
  const controller = createWalletController(deps);
  controllers.push(controller);
  const change = (key: string | null) => {
    const event = new Event("storage");
    Object.defineProperty(event, "key", { value: key });
    events.window.dispatchEvent(event);
  };
  return { controller, events, walletEvents, p, client, sources, shared, calls, deps, change };
}

test("connect and sign once, then refresh: trusted reconnect restores the same token without signing or extending expiry", async () => {
  const first = setup();
  first.controller.start(first.events);
  await tick();
  expect(first.calls.connect).toHaveLength(0);
  await first.controller.connect();
  expect(await first.controller.authenticate()).toBe(token);
  expect(first.calls.signMessage).toBe(1);
  const expiry = first.controller.getSnapshot().sessionExpiresAt;
  first.controller.stop();
  const next = setup(false, first.shared);
  next.controller.start(next.events);
  await tick();
  expect(next.calls.connect).toEqual([{ onlyIfTrusted: true }]);
  expect(next.calls.network).toBe(1);
  expect(next.calls.api).toEqual([]);
  expect(next.calls.signMessage).toBe(0);
  expect(next.controller.getSnapshot()).toMatchObject({
    account: owner.toBase58(),
    chainId: 1,
    sessionToken: token,
    sessionExpiresAt: expiry,
    restoring: false,
  });
  expect(await next.controller.authenticate()).toBe(token);
  expect(next.calls.signMessage).toBe(0);
  expect(() => assertRequestSession(token)).not.toThrow();
});

test("expired authentication still restores the wallet, but cannot authenticate requests until a new signature", async () => {
  const f = setup(true);
  persistWalletSession(
    f.shared,
    createWalletSession(
      sessionBinding(deployment, origin),
      owner.toBase58(),
      token,
      Date.now() - WALLET_SESSION_MS,
    ),
  );
  f.controller.start(f.events);
  await tick();
  expect(f.controller.getSnapshot()).toMatchObject({
    account: owner.toBase58(),
    sessionToken: null,
  });
  expect(f.calls.signMessage).toBe(0);
  expect(() => assertRequestSession(token)).toThrow();
  await f.controller.authenticate();
  expect(f.calls.signMessage).toBe(1);
});

test("StrictMode setup/cleanup/setup issues only one trusted reconnect and stopped providers cannot restore", async () => {
  const f = setup(true);
  f.controller.start(f.events);
  f.controller.stop();
  f.controller.start(f.events);
  await tick();
  expect(f.calls.connect).toHaveLength(1);
  f.controller.stop();
  const old = setup(true),
    wait = deferred<{ publicKey: PublicKey }>();
  old.p.connect = async () => wait.promise;
  old.controller.start(old.events);
  await tick();
  old.controller.stop();
  wait.resolve({ publicKey: owner });
  await tick();
  expect(old.controller.getSnapshot().account).toBeNull();
  expect(() => assertRequestSession(token)).toThrow();
});

test("locked or revoked wallets never prompt for a signature; a later manual connect can reuse the valid session", async () => {
  const f = setup(true);
  const connect = f.p.connect;
  f.p.connect = async (options) => {
    expect(options).toEqual({ onlyIfTrusted: true });
    throw new Error("locked");
  };
  f.controller.start(f.events);
  await tick();
  expect(f.controller.getSnapshot()).toMatchObject({
    account: null,
    sessionToken: null,
    restoring: false,
  });
  expect(f.calls.signMessage).toBe(0);
  f.p.connect = connect;
  await f.controller.connect();
  expect(f.controller.getSnapshot().sessionToken).toBe(token);
});

test("network errors fail closed and a successful explicit retry restores the session", async () => {
  const f = setup(true),
    verify = f.client.assertNetwork;
  f.client.assertNetwork = async () => {
    throw new Error("genesis mismatch");
  };
  f.controller.start(f.events);
  await tick();
  expect(f.controller.getSnapshot()).toMatchObject({
    account: owner.toBase58(),
    chainId: null,
    sessionToken: null,
    error: "genesis mismatch",
  });
  expect(() => assertRequestSession(token)).toThrow();
  f.client.assertNetwork = verify;
  await f.controller.ensureNetwork();
  expect(f.controller.getSnapshot()).toMatchObject({ chainId: 1, sessionToken: token });
});

test("account changes invalidate sessions and in-flight network checks; switching back does not resurrect old authentication", async () => {
  const f = setup(true);
  f.controller.start(f.events);
  await tick();
  const wait = deferred<void>();
  f.client.assertNetwork = async () => wait.promise;
  const network = f.controller.ensureNetwork();
  f.p.publicKey = other;
  f.walletEvents.dispatchEvent(new Event("accountChanged"));
  expect(f.controller.getSnapshot()).toMatchObject({
    account: other.toBase58(),
    chainId: null,
    sessionToken: null,
  });
  expect(f.shared.getItem(SESSION_STORAGE_KEY)).toBeNull();
  wait.resolve();
  await expect(network).rejects.toThrow("changed");
  f.p.publicKey = owner;
  f.walletEvents.dispatchEvent(new Event("accountChanged"));
  await tick();
  expect(f.controller.getSnapshot().sessionToken).toBeNull();
  expect(f.calls.clears).toBeGreaterThan(1);
});

test("a different account returned by trusted reconnect cannot use the previously saved token", async () => {
  const f = setup(true);
  f.p.publicKey = other;
  f.controller.start(f.events);
  await tick();
  expect(f.controller.getSnapshot()).toMatchObject({
    account: other.toBase58(),
    sessionToken: null,
  });
  expect(f.shared.getItem(SESSION_STORAGE_KEY)).toBeNull();
  expect(rememberedWallet(f.shared)?.owner).toBe(other.toBase58());
});

test("disconnect clears persistence even if the extension retains publicKey or rejects disconnect", async () => {
  const f = setup(true);
  f.controller.start(f.events);
  await tick();
  f.p.disconnect = async () => {
    throw new Error("extension closed");
  };
  f.controller.disconnect();
  expect(f.controller.getSnapshot()).toMatchObject({
    account: null,
    chainId: null,
    sessionToken: null,
  });
  expect(f.shared.getItem(WALLET_STORAGE_KEY)).toBeNull();
  expect(f.shared.getItem(SESSION_STORAGE_KEY)).toBeNull();
  f.walletEvents.dispatchEvent(new Event("accountChanged"));
  expect(f.controller.getSnapshot().account).toBeNull();
  await tick();
});

test("cross-tab logout, session replacement, and late 401s cannot keep or overwrite an old session", async () => {
  const f = setup(true);
  f.controller.start(f.events);
  await tick();
  const newer = "b".repeat(64);
  persistWalletSession(
    f.shared,
    createWalletSession(sessionBinding(deployment, origin), owner.toBase58(), newer),
  );
  f.change(SESSION_STORAGE_KEY);
  expect(f.controller.getSnapshot().sessionToken).toBeNull();
  await f.controller.ensureNetwork();
  expect(f.controller.getSnapshot().sessionToken).toBe(newer);
  f.events.window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: token }));
  expect(f.controller.getSnapshot().sessionToken).toBe(newer);
  f.events.window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: newer }));
  expect(f.controller.getSnapshot()).toMatchObject({
    account: owner.toBase58(),
    sessionToken: null,
  });
  expect(f.shared.getItem(SESSION_STORAGE_KEY)).toBeNull();
  f.shared.removeItem(WALLET_STORAGE_KEY);
  f.change(WALLET_STORAGE_KEY);
  expect(f.controller.getSnapshot().account).toBeNull();
});

test("disconnect during sign-in prevents a late API response from reactivating or persisting a session", async () => {
  const f = setup();
  f.controller.start(f.events);
  await tick();
  await f.controller.connect();
  const verify = deferred<{ token: string }>(),
    request = f.deps.request;
  f.deps.request = async <T>(path: string, options: { body: unknown }) =>
    path.endsWith("verify") ? ((await verify.promise) as T) : request<T>(path, options);
  const authentication = f.controller.authenticate();
  await tick();
  expect(f.calls.signMessage).toBe(1);
  await expect(f.controller.authenticate()).rejects.toThrow("already in progress");
  f.controller.disconnect();
  verify.resolve({ token });
  await expect(authentication).rejects.toThrow("changed");
  expect(f.controller.getSnapshot().sessionToken).toBeNull();
  expect(f.shared.getItem(SESSION_STORAGE_KEY)).toBeNull();
});

test("a replaced injected provider without an accountChanged event cannot send authenticated requests", async () => {
  const f = setup(true);
  f.controller.start(f.events);
  await tick();
  f.sources.phantom = { solana: { ...f.p, publicKey: other } };
  expect(() => assertRequestSession(token)).toThrow();
  await expect(
    f.controller.sendTransaction({ to: deployment.programId, data: "test" }),
  ).rejects.toThrow();
  expect(f.calls.signTransaction).toBe(0);
  expect(f.calls.broadcasts).toBe(0);
});

test("transaction review remains exact: mutated messages, wallet changes, and expiry during signing cannot broadcast", async () => {
  for (const change of ["message", "account", "session"] as const) {
    const f = setup(true);
    f.controller.start(f.events);
    await tick();
    f.p.signTransaction = async (tx) => {
      if (change === "message") tx.message.recentBlockhash = other.toBase58();
      if (change === "account") {
        f.p.publicKey = other;
        f.walletEvents.dispatchEvent(new Event("accountChanged"));
      }
      if (change === "session") f.controller.invalidateSession();
      return tx;
    };
    await expect(
      f.controller.sendTransaction({ to: deployment.programId, data: "test" }),
    ).rejects.toThrow();
    expect(f.calls.broadcasts).toBe(0);
    f.controller.stop();
  }
  const f = setup(true);
  f.controller.start(f.events);
  await tick();
  expect(await f.controller.sendTransaction({ to: deployment.programId, data: "test" })).toBe(
    "signature",
  );
  expect(f.calls.broadcasts).toBe(1);
});

test("request-time expiry blocks background tabs before fetch; API 401 invalidates only its request token", async () => {
  const f = setup(true),
    originalFetch = globalThis.fetch;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: f.events.window });
  let calls = 0;
  const now = Date.now;
  globalThis.fetch = (async () => {
    calls++;
    return Response.json({ error: { message: "Expired on server" } }, { status: 401 });
  }) as unknown as typeof fetch;
  try {
    f.controller.start(f.events);
    await tick();
    const expiry = f.controller.getSnapshot().sessionExpiresAt;
    if (expiry === null) throw new Error("Expected a restored session");
    Date.now = () => expiry;
    await expect(requestJson("/api/gateway/orders/prepare", { token, body: {} })).rejects.toThrow(
      "expired",
    );
    expect(calls).toBe(0);
    expect(f.controller.getSnapshot().sessionToken).toBeNull();
    expect(f.controller.getSnapshot().account).toBe(owner.toBase58());
    Date.now = now;
    await f.controller.authenticate();
    await expect(requestJson("/api/gateway/orders/prepare", { token, body: {} })).rejects.toThrow(
      "Expired on server",
    );
    expect(calls).toBe(1);
    expect(f.controller.getSnapshot().sessionToken).toBeNull();
  } finally {
    Date.now = now;
    globalThis.fetch = originalFetch;
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("focus and visibility checks expire sessions without disconnecting the wallet, including clock rollback", async () => {
  const now = Date.now;
  try {
    for (const mode of ["focus", "visibility", "rollback"] as const) {
      const f = setup(true);
      f.controller.start(f.events);
      await tick();
      const saved = JSON.parse(f.shared.getItem(SESSION_STORAGE_KEY) ?? "{}");
      Date.now = () => (mode === "rollback" ? saved.issuedAt - 1 : saved.expiresAt);
      if (mode === "visibility") f.events.document.dispatchEvent(new Event("visibilitychange"));
      else f.events.window.dispatchEvent(new Event("focus"));
      expect(f.controller.getSnapshot()).toMatchObject({
        account: owner.toBase58(),
        sessionToken: null,
      });
      expect(f.shared.getItem(SESSION_STORAGE_KEY)).toBeNull();
      expect(rememberedWallet(f.shared)?.owner).toBe(owner.toBase58());
      f.controller.stop();
      Date.now = now;
    }
  } finally {
    Date.now = now;
  }
});

test("the expiry timer invalidates a short-lived upstream session", async () => {
  const f = setup(true);
  persistWalletSession(
    f.shared,
    createWalletSession(
      sessionBinding(deployment, origin),
      owner.toBase58(),
      token,
      Date.now(),
      Date.now() + 40,
    ),
  );
  f.controller.start(f.events);
  await tick();
  expect(f.controller.getSnapshot().sessionToken).toBe(token);
  await new Promise<void>((resolve) => setTimeout(resolve, 55));
  expect(f.controller.getSnapshot()).toMatchObject({
    account: owner.toBase58(),
    sessionToken: null,
  });
});

test("restoration waits for late injection and respects the remembered provider", async () => {
  const f = setup(true);
  rememberWallet(f.shared, "solflare", owner.toBase58());
  f.controller.start(f.events);
  await tick();
  expect(f.calls.connect).toEqual([]);
  expect(f.controller.getSnapshot().restoring).toBe(true);
  f.sources.solflare = f.p;
  await new Promise<void>((resolve) => setTimeout(resolve, 275));
  expect(f.calls.connect).toEqual([{ onlyIfTrusted: true }]);
  expect(f.controller.getSnapshot()).toMatchObject({ sessionToken: token, restoring: false });
});

test("blocked browser storage retains a usable memory session and exposes a persistence warning", async () => {
  const f = setup();
  f.deps.storage = () => null;
  f.controller.start(f.events);
  await tick();
  await f.controller.connect();
  expect(await f.controller.authenticate()).toBe(token);
  expect(f.controller.getSnapshot().persistenceError).toContain("cannot survive");
  expect(() => assertRequestSession(token)).not.toThrow();
  expect(f.shared.getItem(SESSION_STORAGE_KEY)).toBeNull();
});

test("a foreign deployment session cannot restore, and a forged challenge cannot trigger signing", async () => {
  const f = setup(true);
  persistWalletSession(f.shared, createWalletSession("another network", owner.toBase58(), token));
  f.controller.start(f.events);
  await tick();
  expect(f.controller.getSnapshot().sessionToken).toBeNull();
  f.deps.request = async <T>() =>
    ({ challengeId: "c".repeat(64), message: "Sign something else" }) as T;
  await expect(f.controller.authenticate()).rejects.toThrow("deployment");
  expect(f.calls.signMessage).toBe(0);
});

test("provider disconnect events clear a session even when the provider has not cleared publicKey yet", async () => {
  const f = setup(true);
  f.controller.start(f.events);
  await tick();
  f.walletEvents.dispatchEvent(new Event("disconnect"));
  expect(f.controller.getSnapshot()).toMatchObject({ account: null, sessionToken: null });
  expect(f.shared.getItem(WALLET_STORAGE_KEY)).toBeNull();
  expect(f.shared.getItem(SESSION_STORAGE_KEY)).toBeNull();
});
