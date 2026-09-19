import { afterEach, expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import {
  availableWallets,
  connectWallet,
  findWallet,
  type SolanaWallet,
} from "../src/lib/wallet/injected";
import {
  assertRequestSession,
  browserStorage,
  createWalletSession,
  forget,
  persistWalletSession,
  rememberedWallet,
  rememberWallet,
  SESSION_STORAGE_KEY,
  type SessionStorage,
  savedWalletSession,
  sessionBinding,
  setRequestSession,
  WALLET_SESSION_MS,
  WALLET_STORAGE_KEY,
} from "../src/lib/wallet/session";

const owner = PublicKey.unique(),
  secondOwner = PublicKey.unique(),
  token = "a".repeat(64);
const deployment = {
  programId: PublicKey.unique().toBase58(),
  config: PublicKey.unique().toBase58(),
  genesisHash: "devnet-genesis",
};
const binding = sessionBinding(deployment, "http://localhost:3001"),
  now = 1_800_000_000_000;
const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => {
      values.set(name, value);
    },
    removeItem: (name: string) => {
      values.delete(name);
    },
  } satisfies SessionStorage;
};
const saved = () => createWalletSession(binding, owner.toBase58(), token, now);
afterEach(() => setRequestSession(null));

test("wallet preference has no expiry and remembers the selected wallet; explicit disconnect removes it", () => {
  const s = storage();
  expect(rememberedWallet(s)).toBeNull();
  for (const kind of ["phantom", "solflare", "injected"] as const) {
    expect(rememberWallet(s, kind, owner.toBase58())).toBe(true);
    expect(rememberedWallet(s)).toEqual({ version: 1, kind, owner: owner.toBase58() });
  }
  expect(s.getItem(WALLET_STORAGE_KEY)).not.toContain("expires");
  forget(s, WALLET_STORAGE_KEY);
  expect(rememberedWallet(s)).toBeNull();
  expect(() => rememberWallet(s, "phantom", "bad-address")).toThrow();
});

test("refresh reuses the issued token without re-signing or extending the absolute 30-day expiry", () => {
  const s = storage(),
    value = saved();
  expect(value.expiresAt - value.issuedAt).toBe(30 * 24 * 60 * 60 * 1000);
  expect(persistWalletSession(s, value)).toBe(true);
  for (const elapsed of [0, 1, 60_000, WALLET_SESSION_MS - 1]) {
    expect(savedWalletSession(s, binding, owner.toBase58(), now + elapsed)).toEqual(value);
    expect(JSON.parse(s.getItem(SESSION_STORAGE_KEY) ?? "{}").issuedAt).toBe(now);
  }
  expect(savedWalletSession(s, binding, owner.toBase58(), value.expiresAt)).toBeNull();
  expect(savedWalletSession(s, binding, owner.toBase58(), value.expiresAt + 1)).toBeNull();
  expect(s.getItem(SESSION_STORAGE_KEY)).not.toContain("signature");
  expect(s.getItem(SESSION_STORAGE_KEY)).not.toContain("privateKey");
});

test("saved sessions never cross wallet, site, network, program, or config boundaries", () => {
  const s = storage();
  persistWalletSession(s, saved());
  expect(savedWalletSession(s, binding, secondOwner.toBase58(), now)).toBeNull();
  for (const scope of [
    sessionBinding(deployment, "http://other.test:3001"),
    ...(["config", "programId", "genesisHash"] as const).map((field) =>
      sessionBinding({ ...deployment, [field]: "other" }, "http://localhost:3001"),
    ),
  ])
    expect(savedWalletSession(s, scope, owner.toBase58(), now)).toBeNull();
});

test("invalid, malformed, future-issued, overlong and tampered lifetimes fail closed", () => {
  const s = storage(),
    good = saved();
  for (const changes of [
    { version: 2 },
    { owner: "bad" },
    { token: "not-a-token" },
    { token: "A".repeat(64) },
    { issuedAt: now + 1 },
    { issuedAt: -1 },
    { issuedAt: String(now) },
    { issuedAt: 1.5 },
    { expiresAt: good.expiresAt + 1 },
    { expiresAt: now },
    { expiresAt: -1 },
    { expiresAt: String(good.expiresAt) },
    { expiresAt: 1.5 },
  ]) {
    s.setItem(SESSION_STORAGE_KEY, JSON.stringify({ ...good, ...changes }));
    expect(savedWalletSession(s, binding, owner.toBase58(), now)).toBeNull();
  }
  for (const input of ["null", "[]", "{}", "not json", "false"]) {
    s.setItem(SESSION_STORAGE_KEY, input);
    s.setItem(WALLET_STORAGE_KEY, input);
    expect(savedWalletSession(s, binding, owner.toBase58(), now)).toBeNull();
    expect(rememberedWallet(s)).toBeNull();
  }
  persistWalletSession(s, good);
  for (const at of [NaN, Infinity, -1, now - 1])
    expect(savedWalletSession(s, binding, owner.toBase58(), at)).toBeNull();
});

test("a shorter upstream expiry is respected; longer upstream sessions cannot extend UI reuse", () => {
  expect(createWalletSession(binding, owner.toBase58(), token, now, now + 1000).expiresAt).toBe(
    now + 1000,
  );
  expect(
    createWalletSession(binding, owner.toBase58(), token, now, String(now + 1000)).expiresAt,
  ).toBe(now + 1000);
  expect(
    createWalletSession(binding, owner.toBase58(), token, now, now + 2 * WALLET_SESSION_MS)
      .expiresAt,
  ).toBe(now + WALLET_SESSION_MS);
  for (const expiry of [null, now, now - 1, "nonsense", "1.5", "1e30", Infinity, NaN])
    expect(() => createWalletSession(binding, owner.toBase58(), token, now, expiry)).toThrow();
  for (const bad of ["", "a".repeat(63), "g".repeat(64), null])
    expect(() => createWalletSession(binding, owner.toBase58(), bad, now)).toThrow();
  for (const at of [NaN, -1, Infinity, Number.MAX_SAFE_INTEGER])
    expect(() => createWalletSession(binding, owner.toBase58(), token, at)).toThrow();
});

test("blocked storage degrades to a memory session without throwing or pretending it persisted", () => {
  const denied = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
    removeItem() {
      throw new Error("blocked");
    },
  };
  for (const s of [null, denied]) {
    expect(rememberedWallet(s)).toBeNull();
    expect(savedWalletSession(s, binding, owner.toBase58(), now)).toBeNull();
    expect(rememberWallet(s, "phantom", owner.toBase58())).toBe(false);
    expect(persistWalletSession(s, saved())).toBe(false);
    expect(() => forget(s, SESSION_STORAGE_KEY)).not.toThrow();
  }
  expect(browserStorage()).toBeNull(); // SSR/test environment has no browser.
});

test("request-time gate rejects expired, replaced and logged-out sessions even without an expiry timer", () => {
  expect(() => assertRequestSession(token, now)).toThrow();
  setRequestSession(saved());
  expect(() => assertRequestSession(token, now + WALLET_SESSION_MS - 1)).not.toThrow();
  for (const at of [now - 1, now + WALLET_SESSION_MS, now + WALLET_SESSION_MS + 1, NaN])
    expect(() => assertRequestSession(token, at)).toThrow();
  expect(() => assertRequestSession("b".repeat(64), now)).toThrow();
  setRequestSession(createWalletSession(binding, owner.toBase58(), "b".repeat(64), now));
  expect(() => assertRequestSession(token, now)).toThrow();
  setRequestSession(null);
  expect(() => assertRequestSession("b".repeat(64), now)).toThrow();
});

const wallet = () => {
  const calls: unknown[] = [];
  const p: SolanaWallet = {
    publicKey: owner,
    connect: async (options) => {
      calls.push(options);
      return { publicKey: owner };
    },
    disconnect: async () => {},
    signMessage: async () => {
      throw new Error("must not sign during restoration");
    },
    signTransaction: async () => {
      throw new Error("must not sign during restoration");
    },
  };
  return { p, calls };
};

test("remembered wallet selection never silently switches to a newly installed default provider", () => {
  const phantom = wallet().p,
    solflare = wallet().p;
  expect(findWallet({ phantom: { solana: phantom }, solflare }, "solflare")).toEqual({
    kind: "solflare",
    provider: solflare,
  });
  expect(findWallet({ phantom: { solana: phantom } }, "solflare")).toBeNull();
  expect(findWallet({})).toBeNull();
  expect(findWallet({ solana: phantom })).toEqual({ kind: "injected", provider: phantom });
});

test("wallet choices include each distinct Solana provider once", () => {
  const phantom = wallet().p;
  const solflare = wallet().p;
  expect(
    availableWallets({ phantom: { solana: phantom }, solflare, solana: phantom }).map(
      (w) => w.kind,
    ),
  ).toEqual(["phantom", "solflare"]);
  expect(availableWallets({ solana: solflare }).map((w) => w.kind)).toEqual(["injected"]);
});

test("known wallets reconnect only if trusted, while manual connection remains explicit", async () => {
  for (const kind of ["phantom", "solflare"] as const) {
    const { p, calls } = wallet();
    expect(await connectWallet({ kind, provider: p }, true)).toBe(owner.toBase58());
    expect(calls).toEqual([{ onlyIfTrusted: true }]);
    await connectWallet({ kind, provider: p }, false);
    expect(calls[1]).toBeUndefined();
  }
  const { p } = wallet();
  p.isPhantom = true;
  expect(await connectWallet({ kind: "injected", provider: p }, true)).toBe(owner.toBase58());
});

test("manual wallet connection passes no options argument to injected providers", async () => {
  const { p } = wallet();
  p.connect = async function () {
    if (arguments.length !== 0) throw new Error("Unexpected error");
    return { publicKey: owner };
  };
  expect(await connectWallet({ kind: "phantom", provider: p }, false)).toBe(owner.toBase58());
});

test("an already connected wallet can be reused without asking the extension again", async () => {
  const { p } = wallet();
  p.isConnected = true;
  p.connect = async () => {
    throw new Error("Unexpected error");
  };
  expect(await connectWallet({ kind: "phantom", provider: p }, false)).toBe(owner.toBase58());
});

test("unknown wallets are never prompted automatically; lock/revoke/mismatch errors cannot restore authentication", async () => {
  const { p, calls } = wallet();
  await expect(connectWallet({ kind: "injected", provider: p }, true)).rejects.toThrow("manually");
  expect(calls).toEqual([]);
  p.isConnected = true;
  expect(await connectWallet({ kind: "injected", provider: p }, true)).toBe(owner.toBase58());
  expect(calls).toEqual([]);
  p.connect = async () => {
    throw new Error("not trusted");
  };
  await expect(connectWallet({ kind: "phantom", provider: p }, true)).rejects.toThrow(
    "not trusted",
  );
  p.connect = async () => ({ publicKey: secondOwner });
  await expect(connectWallet({ kind: "phantom", provider: p }, true)).rejects.toThrow("changed");
  p.connect = async () => undefined;
  p.publicKey = null;
  await expect(connectWallet({ kind: "phantom", provider: p }, true)).rejects.toThrow("changed");
});
