import { expect, test } from "bun:test";
import { Buffer } from "buffer";
import {
  AccountLayout,
  MintLayout,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, type AccountInfo } from "@solana/web3.js";
import {
  SolanaClient,
  PublicKey,
  bn,
  encodeAccount,
  vaultAddress,
  claimAddress,
  claimAsset,
  poolAddress,
  poolVaultAddress,
  underlyingAsset,
  type AssetPoolAccount,
  type MarketAccount,
} from "@conditional-stocks/solana-client";
import type { Snapshot } from "../src/projection";
import { reconcileVaults } from "../src/reconcile.ts";
import { marketFixture } from "./custody-fixture";

const publicKey = () => Keypair.generate().publicKey;
const info = (owner: PublicKey, data: Buffer): AccountInfo<Buffer> => ({
  owner,
  data,
  executable: false,
  lamports: 10_000_000,
  rentEpoch: 0,
});
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** One market with the quote and `legs` issuer legs, every listed collateral
 * initialized. Per collateral c: backing 50 (quote) / 40 (legs), a pool-funded
 * reservation of 20, and per claim asset 10 credit + 20 escrow + a small fee.
 * Claim supplies are 45 (quote) and 35 (legs). */
async function fixture(legs = 1, domain?: { config: PublicKey; program: PublicKey }) {
  const config = domain?.config ?? publicKey(),
    program = domain?.program ?? publicKey(),
    market = publicKey(),
    quote = publicKey(),
    bases = Array.from({ length: legs }, publicKey);
  const state: MarketAccount = marketFixture({
    config,
    market,
    program,
    quote,
    bases,
    id: new Uint8Array(32).fill(1),
  });
  state.terms.trading_cutoff = bn(100);
  const collaterals = Array.from({ length: legs + 1 }, (_, c) => c);
  for (const c of collaterals) {
    state.backing[c] = bn(c === 0 ? 50 : 40);
    state.escrow[underlyingAsset(c)] = bn(20);
    for (const branch of [0, 1]) {
      const asset = claimAsset(c, branch);
      state.credits[asset] = bn(10);
      state.escrow[asset] = bn(20);
      state.fees[asset] = bn(1 + (asset % 3));
    }
  }
  const mintOf = (c: number) => state.mints[underlyingAsset(c)]!;
  const poolKeys = collaterals.map((c) => poolAddress(config, mintOf(c), program));
  const poolStates: AssetPoolAccount[] = collaterals.map((c) => ({
    config,
    mint: mintOf(c),
    token_program: TOKEN_PROGRAM_ID,
    decimals: 6,
    liability: bn(c === 0 ? 70 : 60),
    bump: 0,
    admitted: 0,
    vault_bump: 0,
  }));
  const token = (authority: PublicKey, mint: PublicKey, amount: bigint) => {
    const data = Buffer.alloc(AccountLayout.span);
    AccountLayout.encode(
      {
        mint,
        owner: authority,
        amount,
        delegateOption: 0,
        delegate: PublicKey.default,
        state: 1,
        isNativeOption: 0,
        isNative: 0n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: PublicKey.default,
      },
      data,
    );
    return info(TOKEN_PROGRAM_ID, data);
  };
  const claim = (supply: bigint, authority = market, decimals = 6, freeze = false) => {
    const data = Buffer.alloc(MintLayout.span);
    MintLayout.encode(
      {
        mintAuthorityOption: 1,
        mintAuthority: authority,
        supply,
        decimals,
        isInitialized: true,
        freezeAuthorityOption: freeze ? 1 : 0,
        freezeAuthority: market,
      },
      data,
    );
    return info(TOKEN_PROGRAM_ID, data);
  };
  const address = {
    pool: (c: number) => poolKeys[c]!,
    poolVault: (c: number) => poolVaultAddress(poolKeys[c]!, program),
    vault: (asset: number) => vaultAddress(market, asset, program),
    mint: (asset: number) => claimAddress(market, asset, program),
  };
  const all = new Map<string, AccountInfo<Buffer> | null>();
  const put = (key: PublicKey, value: AccountInfo<Buffer> | null) => all.set(String(key), value);
  const get = (key: PublicKey) => all.get(String(key)) ?? null;
  const writeMarket = () => put(market, info(program, encodeAccount("Market", state)));
  const writePools = () =>
    collaterals.forEach((c) =>
      put(address.pool(c), info(program, encodeAccount("AssetPool", poolStates[c]!))),
    );
  const claimVaultAmount = (asset: number) =>
    BigInt(state.credits[asset]!.toString()) +
    BigInt(state.escrow[asset]!.toString()) +
    BigInt(state.fees[asset]!.toString());
  writeMarket();
  writePools();
  for (const c of collaterals) {
    put(address.poolVault(c), token(address.pool(c), mintOf(c), c === 0 ? 70n : 60n));
    for (const branch of [0, 1]) {
      const asset = claimAsset(c, branch);
      put(address.vault(asset), token(market, state.mints[asset]!, claimVaultAmount(asset)));
      put(address.mint(asset), claim(c === 0 ? 45n : 35n));
    }
  }
  const calls: { addresses: PublicKey[]; options: unknown }[] = [];
  const client = {
    config,
    program,
    connection: {
      getMultipleAccountsInfoAndContext: async (addresses: PublicKey[], options: unknown) => {
        calls.push({ addresses, options });
        writePools();
        return { context: { slot: 100 }, value: addresses.map(get) };
      },
    },
  } as unknown as SolanaClient;
  const snapshot = {
    program,
    slot: 90,
    observedAt: Date.now(),
    config: { quote_mint: quote },
    markets: new Map([
      [
        String(market),
        {
          ...state,
          backing: [...state.backing],
          credits: state.credits.map(() => bn(0)),
          escrow: state.escrow.map(() => bn(0)),
        },
      ],
    ]),
    pools: new Map(
      poolKeys.map((p, c) => [
        String(p),
        { ...poolStates[c]!, liability: bn(c === 0 ? 50 : 40) } as AssetPoolAccount,
      ]),
    ),
    credits: new Map(),
    wallets: new Map(),
    orders: new Map(),
    traders: new Map(),
  } as Snapshot;
  return {
    client,
    state,
    market,
    bases,
    collaterals,
    calls,
    token,
    claim,
    program,
    snapshot,
    poolKeys,
    poolStates,
    address,
    put,
    get,
    writeMarket,
    all,
  };
}

test("global pools and market claims use coherent bank reads, not cached liabilities", async () => {
  const f = await fixture(),
    report = await reconcileVaults(f.client, f.snapshot);
  expect(report).toMatchObject({
    healthy: true,
    checkedVaults: 6,
    checkedMints: 4,
    slot: "100",
  });
  expect(f.calls).toHaveLength(2);
  expect(f.calls[0]?.options).toEqual({ commitment: "finalized", minContextSlot: 90 });
  expect(f.calls[0]?.addresses.map(String)).toEqual(
    f.poolKeys.flatMap((p) => [p, poolVaultAddress(p, f.program)]).map(String),
  );
  expect(f.calls[1]?.addresses.map(String)).toEqual(
    [
      f.market,
      ...[0, 1].flatMap((c) =>
        [0, 1].flatMap((branch) => [
          f.address.vault(claimAsset(c, branch)),
          f.address.mint(claimAsset(c, branch)),
        ]),
      ),
    ].map(String),
  );
  f.put(f.address.poolVault(0), f.token(f.poolKeys[0]!, f.state.mints[0]!, 71n));
  expect((await reconcileVaults(f.client, f.snapshot)).healthy).toBe(true);
});

test("three issuer legs are reconciled per collateral: pools, claim vaults, mints and backing", async () => {
  const f = await fixture(3);
  const report = await reconcileVaults(f.client, f.snapshot);
  // Four pools (quote + three legs), eight claim vaults, eight claim mints.
  expect(report).toMatchObject({ checkedVaults: 12, checkedMints: 8 });
  expect(f.calls[1]!.addresses).toHaveLength(1 + 4 * 4);
  for (const mutate of [
    // Leg-3 NO vault one raw unit short.
    (g: Fixture) =>
      g.put(
        g.address.vault(11),
        g.token(g.market, g.state.mints[11]!, 10n + 20n + BigInt(g.state.fees[11]!.toString()) - 1n),
      ),
    // Leg-2 YES supply exceeds that leg's own backing (legs never share backing).
    (g: Fixture) => g.put(g.address.mint(7), g.claim(41n)),
    // Leg-2 claim mint decimals differ from the leg's recorded decimals.
    (g: Fixture) => g.put(g.address.mint(8), g.claim(35n, g.market, 9)),
    // Leg-3 pool vault short of backing + reservations.
    (g: Fixture) => g.put(g.address.poolVault(3), g.token(g.poolKeys[3]!, g.bases[2]!, 59n)),
    // Leg-1 pool's decimals disagree with the market's leg decimals.
    (g: Fixture) => {
      g.snapshot.pools.get(String(g.poolKeys[1]))!.decimals = 9;
    },
    // The listed leg's pool is missing from the program image.
    (g: Fixture) => {
      g.snapshot.pools.delete(String(g.poolKeys[2]));
    },
    // Initialization bits beyond the listed collaterals.
    (g: Fixture) => {
      g.state.bases = 2;
      g.writeMarket();
    },
  ]) {
    const g = await fixture(3);
    mutate(g);
    await expect(reconcileVaults(g.client, g.snapshot)).rejects.toThrow();
  }
  // A leg listed after the program snapshot is reconciled on the next pass.
  const raced = await fixture(2);
  const before = raced.snapshot.markets.get(String(raced.market))!;
  before.bases = 1;
  before.vaults_initialized &= (1 << 6) - 1;
  before.backing[2] = bn(0);
  raced.snapshot.pools.get(String(raced.poolKeys[2]))!.liability = bn(0);
  await expect(reconcileVaults(raced.client, raced.snapshot)).rejects.toThrow("listing changed");
});

test("a single raw-unit shortage in any custody category fails reconciliation", async () => {
  const cases: ((f: Fixture) => void)[] = [
    ...[0, 1].map((c) => (f: Fixture) => {
      f.put(
        f.address.poolVault(c),
        f.token(f.poolKeys[c]!, f.state.mints[underlyingAsset(c)]!, (c === 0 ? 70n : 60n) - 1n),
      );
    }),
    ...[1, 2, 4, 5].map((asset) => (f: Fixture) => {
      const amount =
        10n + 20n + BigInt(f.state.fees[asset]!.toString()) - 1n;
      f.put(f.address.vault(asset), f.token(f.market, f.state.mints[asset]!, amount));
    }),
  ];
  for (const mutate of cases) {
    const f = await fixture();
    mutate(f);
    await expect(reconcileVaults(f.client, f.snapshot)).rejects.toThrow("undercollateralized");
  }
});

test("missing accounts, foreign deployment, mint and authority substitutions fail closed", async () => {
  for (const mutate of [
    (f: Fixture) => f.put(f.market, null),
    (f: Fixture) => f.put(f.address.poolVault(0), null),
    (f: Fixture) => f.put(f.address.poolVault(0), f.token(publicKey(), f.state.mints[0]!, 70n)),
    (f: Fixture) => f.put(f.address.poolVault(0), f.token(f.poolKeys[0]!, publicKey(), 70n)),
    (f: Fixture) => {
      f.get(f.address.poolVault(0))!.owner = publicKey();
    },
    (f: Fixture) => {
      f.get(f.market)!.owner = publicKey();
    },
    (f: Fixture) => {
      f.state.config = publicKey();
      f.writeMarket();
    },
  ]) {
    const f = await fixture();
    mutate(f);
    await expect(reconcileVaults(f.client, f.snapshot)).rejects.toThrow();
  }
});

test("a partially initialized market checks only its declared vaults", async () => {
  const f = await fixture();
  f.state.vaults_initialized = 1;
  f.state.backing = f.state.backing.map(() => bn(0));
  f.state.credits = f.state.credits.map(() => bn(0));
  f.state.escrow = f.state.escrow.map((_, a) => bn(a === 0 ? 20 : 0));
  f.state.fees = f.state.fees.map(() => bn(0));
  f.writeMarket();
  for (const asset of [1, 2, 4, 5]) {
    f.put(f.address.vault(asset), null);
    f.put(f.address.mint(asset), null);
  }
  expect((await reconcileVaults(f.client, f.snapshot)).checkedVaults).toBe(2);
  const empty = { ...f.snapshot, markets: new Map(), pools: new Map() };
  expect((await reconcileVaults(f.client, empty)).checkedVaults).toBe(0);
});

test("Token-2022 withheld fees never cover spendable liabilities; claim vaults stay classic", async () => {
  const f = await fixture(),
    vault = f.get(f.address.poolVault(0))!;
  const extended = Buffer.alloc(178);
  vault.data.copy(extended);
  extended[165] = 2;
  extended.writeUInt16LE(2, 166);
  extended.writeUInt16LE(8, 168);
  extended.writeBigUInt64LE(1000n, 170);
  f.put(f.address.poolVault(0), { ...vault, owner: TOKEN_2022_PROGRAM_ID, data: extended });
  f.poolStates[0]!.token_program = TOKEN_2022_PROGRAM_ID;
  expect((await reconcileVaults(f.client, f.snapshot)).healthy).toBe(true);
  extended.writeBigUInt64LE(69n, 64);
  await expect(reconcileVaults(f.client, f.snapshot)).rejects.toThrow("undercollateralized");
  extended.writeBigUInt64LE(70n, 64);
  f.get(f.address.vault(1))!.owner = TOKEN_2022_PROGRAM_ID;
  await expect(reconcileVaults(f.client, f.snapshot)).rejects.toThrow("claim vault");
});

test("frozen custody is not advertised as ready even when fully collateralized", async () => {
  const f = await fixture();
  f.get(f.address.poolVault(0))!.data[108] = 2;
  await expect(reconcileVaults(f.client, f.snapshot)).rejects.toThrow("frozen");
});

test("external claim supply cannot hide behind apparently solvent recorded custody", async () => {
  const f = await fixture();
  // Every vault still exactly covers recorded liabilities. Forty-one leg YES
  // tokens (including external holdings) cannot be backed by forty underlying.
  f.put(f.address.mint(4), f.claim(41n));
  await expect(reconcileVaults(f.client, f.snapshot)).rejects.toThrow("outstanding claim supply");
  f.put(f.address.mint(4), f.claim(33n)); // voluntary external burn creates safe excess backing
  expect((await reconcileVaults(f.client, f.snapshot)).healthy).toBe(true);
  f.put(f.address.mint(4), f.claim(31n)); // less than the canonical claim vault itself
  await expect(reconcileVaults(f.client, f.snapshot)).rejects.toThrow("exceeds total mint supply");
});

test("resolved supply uses the payout and a conservative INVALID ceiling, including archive", async () => {
  for (const state of [6, 7]) {
    const f = await fixture();
    f.state.state = state;
    f.state.payouts = [1, 0];
    f.put(f.address.mint(4), f.claim(40n));
    f.put(f.address.mint(5), f.claim((1n << 64n) - 1n));
    f.writeMarket();
    expect((await reconcileVaults(f.client, f.snapshot)).healthy).toBe(true);
    f.state.payouts = [0, 1];
    f.writeMarket();
    await expect(reconcileVaults(f.client, f.snapshot)).rejects.toThrow("outstanding claim supply");
    f.state.payouts = [1, 1];
    f.put(f.address.mint(5), f.claim(41n));
    f.writeMarket();
    await expect(reconcileVaults(f.client, f.snapshot)).rejects.toThrow("outstanding claim supply");
    f.state.backing[1] = bn(41);
    f.poolStates[1]!.liability = bn(61);
    f.put(f.address.poolVault(1), f.token(f.poolKeys[1]!, f.bases[0]!, 61n));
    f.writeMarket();
    expect((await reconcileVaults(f.client, f.snapshot)).healthy).toBe(true);
    f.state.payouts = [0, 0];
    f.writeMarket();
    await expect(reconcileVaults(f.client, f.snapshot)).rejects.toThrow("Invalid finalized payout");
  }
});

test("missing, substituted, delegated, frozen and wrong-decimal claim mints fail closed", async () => {
  for (const mutate of [
    (f: Fixture) => f.put(f.address.mint(4), null),
    (f: Fixture) => {
      f.get(f.address.mint(4))!.owner = TOKEN_2022_PROGRAM_ID;
    },
    (f: Fixture) => f.put(f.address.mint(4), f.claim(35n, publicKey())),
    (f: Fixture) => f.put(f.address.mint(4), f.claim(35n, f.market, 9)),
    (f: Fixture) => f.put(f.address.mint(4), f.claim(35n, f.market, 6, true)),
    (f: Fixture) => {
      f.state.mints[4] = publicKey();
      f.put(f.address.vault(4), f.token(f.market, f.state.mints[4], 32n));
      f.writeMarket();
    },
  ]) {
    const f = await fixture();
    mutate(f);
    await expect(reconcileVaults(f.client, f.snapshot)).rejects.toThrow();
  }
});

test("pool and conditional custody batching never exceeds 100 accounts", async () => {
  const first = await fixture();
  const fixtures = [
    first,
    ...(await Promise.all(
      Array.from({ length: 22 }, (_, i) =>
        fixture(i < 10 ? 1 : 3, { config: first.state.config, program: first.program }),
      ),
    )),
  ];
  const all = new Map<string, AccountInfo<Buffer> | null>();
  for (const f of fixtures) for (const [k, v] of f.all) all.set(k, v);
  const counts: number[] = [];
  first.client.connection.getMultipleAccountsInfoAndContext = async (addresses, options) => {
    counts.push(addresses.length);
    expect(options).toEqual({ commitment: "finalized", minContextSlot: 90 });
    return {
      context: { slot: 100 + counts.length },
      value: addresses.map((a) => all.get(String(a)) ?? null),
    };
  };
  const result = await reconcileVaults(first.client, {
    ...first.snapshot,
    pools: new Map(fixtures.flatMap((f) => [...f.snapshot.pools])),
    markets: new Map(fixtures.flatMap((f) => [...f.snapshot.markets])),
  });
  expect(counts.every((n) => n <= 100)).toBe(true);
  // 11 one-leg markets (2 pools, 9 accounts each), 12 three-leg markets
  // (4 pools, 17 accounts each).
  const pools = 11 * 2 + 12 * 4;
  expect(counts).toEqual([100, 40, 99, 85, 85, 34]);
  expect(counts.reduce((a, b) => a + b, 0)).toBe(2 * pools + 11 * 9 + 12 * 17);
  expect(result).toMatchObject({
    checkedVaults: pools + 11 * 4 + 12 * 8,
    checkedMints: 11 * 4 + 12 * 8,
    slot: "106",
  });
});
