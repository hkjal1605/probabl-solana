import { expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { WalletIndex } from "../src/wallet-index";
import type { Snapshot } from "../src/projection";
import { bn, assetCreditAddress } from "@conditional-stocks/solana-client";
import { custodyFixture } from "./custody-fixture";

test("new indexed credit reuses external reads without duplicating shared balances", async () => {
  const { s, owner, quote } = custodyFixture();
  let calls = 0;
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 0n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  const mints = new Set([...s.markets.values()].flatMap((m) => m.mints.map(String)));
  const client = {
    program: s.program,
    connection: {
      getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => {
        calls++;
        return {
          context: { slot: s.slot },
          value: keys.map((k) =>
            mints.has(String(k))
              ? {
                  data,
                  owner: TOKEN_PROGRAM_ID,
                  executable: false,
                  lamports: 1,
                  rentEpoch: 0,
                }
              : null,
          ),
        };
      },
    },
  };
  const index = new WalletIndex(
    client as any,
    { putWallet: async () => {} } as any,
    "test",
    () => s,
  );
  const first = await index.get(String(owner));
  expect(first.balances[String(quote)]).toMatchObject({
    vaultAvailable: "200",
    creditBalances: {},
    blockNumber: "100",
  });
  const [poolId] = [...s.pools].find(([, p]) => p.mint.equals(quote))!;
  s.credits.get(String(assetCreditAddress(new PublicKey(poolId), owner, s.program)))!.available =
    bn(150);
  s.slot = 101;
  const next = await index.get(String(owner));
  expect(next.balances[String(quote)]).toMatchObject({
    vaultAvailable: "150",
    creditBalances: {},
    blockNumber: "101",
    externalBlockNumber: "100",
  });
  expect(calls).toBe(2);
  expect(next.positions).toHaveLength(2);
});

test("concurrent positions/balance consumers share one persisted batched wallet image", async () => {
  const mint = PublicKey.unique(),
    owner = PublicKey.unique().toBase58();
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 0n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  let calls = 0,
    commits = 0;
  const client = {
    program: PublicKey.unique(),
    connection: {
      getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => {
        calls++;
        return {
          context: { slot: 100 },
          value: keys.map((k) =>
            k.equals(mint)
              ? {
                  data,
                  owner: TOKEN_PROGRAM_ID,
                  executable: false,
                  lamports: 1,
                  rentEpoch: 0,
                }
              : null,
          ),
        };
      },
    },
  };
  const state = {
    observedAt: Date.now(),
    pools: new Map(),
    credits: new Map(),
    wallets: new Map(),
    orders: new Map(),
    slot: 100,
    markets: new Map([
      [
        PublicKey.unique().toBase58(),
        {
          mints: Array(6).fill(mint),
          decimals: [6, 6],
          state: 2,
          vaults_initialized: 63,
        },
      ],
    ]),
  } as Snapshot;
  const db = {
    putWallet: async () => {
      commits++;
      return { rows: [] };
    },
  };
  const index = new WalletIndex(client as any, db as any, "test", () => state);
  const [first, second] = await Promise.all([index.get(owner), index.get(owner)]);
  expect(first).toBe(second);
  expect(calls).toBe(2);
  expect(commits).toBe(1);
  expect(first.positions).toEqual([]);
  expect(first.balances[mint.toBase58()]?.canonicalBalance).toBe("0");
  expect(await index.get(owner)).toBe(first);
  expect(calls).toBe(2);
  await index.get(PublicKey.unique().toBase58());
  expect(calls).toBe(3); // Mint metadata shared across wallets; only another ATA/credit batch.
});

test("failed persistence and incomplete RPC reads cannot publish a wallet image", async () => {
  const owner = PublicKey.unique().toBase58();
  const client = { program: PublicKey.unique(), connection: {} };
  const state = {
    observedAt: Date.now(),
    pools: new Map(),
    credits: new Map(),
    wallets: new Map(),
    orders: new Map(),
    slot: 100,
    markets: new Map(),
  } as Snapshot;
  const index = new WalletIndex(
    client as any,
    {
      putWallet: async () => {
        throw new Error("DB unavailable");
      },
    } as any,
    "test",
    () => state,
  );
  await expect(index.get(owner)).rejects.toThrow("DB unavailable");
  expect(index.peek(owner)).toBeUndefined();
});
