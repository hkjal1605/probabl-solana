import { expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { WalletIndex } from "../src/wallet-index";
import type { Snapshot } from "../src/projection";
import { bn, assetCreditAddress } from "@conditional-stocks/solana-client";
import { custodyFixture, marketFixture } from "./custody-fixture";

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
  expect(next.positions[0]).toMatchObject({
    quoteYes: "0",
    quoteNo: "0",
    bases: [{ collateral: 1, yes: "20", no: "0" }],
    protocolVersion: 3,
  });
});

test("wallet images index every issuer pool and every listed leg's claim mints", async () => {
  const { s, owner, bases, quote } = custodyFixture(3);
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
  const [id, market] = [...s.markets][0]!;
  // Leg 3's claims are not initialized: its claim mints are not indexed.
  market.vaults_initialized &= ~(0b110 << 9);
  const requested = new Set<string>();
  const client = {
    program: s.program,
    connection: {
      getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => {
        for (const k of keys) requested.add(String(k));
        const mints = new Set([...s.markets.values()].flatMap((m) => m.mints.map(String)));
        return {
          context: { slot: s.slot },
          value: keys.map((k) =>
            mints.has(String(k))
              ? { data, owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1, rentEpoch: 0 }
              : null,
          ),
        };
      },
    },
  };
  const index = new WalletIndex(client as any, { putWallet: async () => {} } as any, "t", () => s);
  const image = await index.get(String(owner));
  for (const mint of [quote, ...bases]) expect(image.balances[String(mint)]).toBeDefined();
  for (const asset of [1, 2, 4, 5, 7, 8])
    expect(image.balances[String(market.mints[asset])]?.creditBalances).toEqual({
      [id]: asset === 4 ? "20" : "0",
    });
  for (const asset of [10, 11]) {
    expect(image.balances[String(market.mints[asset])]).toBeUndefined();
    expect(requested.has(String(market.mints[asset]))).toBe(false);
  }
  expect(image.positions.find((p) => p.marketId === id)).toMatchObject({
    bases: [
      { collateral: 1, mint: String(bases[0]), yes: "20" },
      { collateral: 2, mint: String(bases[1]), yes: "0" },
    ],
  });
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
          ...marketFixture({
            config: PublicKey.unique(),
            market: PublicKey.unique(),
            quote: mint,
            bases: [mint],
          }),
          mints: Array(12).fill(mint),
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

test("an issuer token that later enables a transfer hook stays indexed as custody-halted", async () => {
  const fixture = await Bun.file(
    new URL(
      "../../../packages/solana-client/test/fixtures/mint-Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh.json",
      import.meta.url,
    ),
  ).json();
  const mint = new PublicKey(fixture.address),
    owner = PublicKey.unique().toBase58();
  const data = Buffer.from(fixture.data, "base64");
  // TransferHook extension (type 14) at TLV offset 441: set its program id.
  expect(data.readUInt16LE(441)).toBe(14);
  PublicKey.unique().toBuffer().copy(data, 441 + 4 + 32);
  const state = {
    observedAt: Date.now(),
    pools: new Map([
      [
        PublicKey.unique().toBase58(),
        {
          mint,
          decimals: 8,
          token_program: new PublicKey(fixture.owner),
        },
      ],
    ]),
    credits: new Map(),
    wallets: new Map(),
    orders: new Map(),
    slot: 100,
    markets: new Map(),
  } as unknown as Snapshot;
  const client = {
    program: PublicKey.unique(),
    connection: {
      getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => ({
        context: { slot: 100 },
        value: keys.map((k) =>
          k.equals(mint)
            ? { data, owner: new PublicKey(fixture.owner), executable: false, lamports: 1, rentEpoch: 0 }
            : null,
        ),
      }),
    },
  };
  const index = new WalletIndex(client as any, { putWallet: async () => {} } as any, "t", () => state);
  const image = await index.get(owner);
  expect(image.balances[mint.toBase58()]).toMatchObject({
    decimals: 8,
    custodyHalted: true,
    canonicalBalance: "0",
  });
});
