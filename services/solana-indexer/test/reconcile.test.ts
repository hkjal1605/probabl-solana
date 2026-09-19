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
  coder,
  bn,
  vaultAddress,
  claimAddress,
  poolAddress,
  poolVaultAddress,
  type AssetPoolAccount,
} from "@conditional-stocks/solana-client";
import type { Snapshot } from "../src/projection";
import { reconcileVaults } from "../src/reconcile.ts";

const publicKey = () => Keypair.generate().publicKey;
async function fixture(domain?: { config: PublicKey; program: PublicKey }) {
  const config = domain?.config ?? publicKey(),
    program = domain?.program ?? publicKey(),
    market = publicKey(),
    mints = [
      publicKey(),
      publicKey(),
      ...Array.from({ length: 4 }, (_, a) => claimAddress(market, a + 2, program)),
    ];
  const state = {
    config,
    id: Array(32).fill(1),
    terms: {
      condition: Array(32).fill(2),
      yes_index: 1,
      no_index: 2,
      rules_hash: Array(32).fill(3),
      metadata_hash: Array(32).fill(4),
      metadata_uri: "ipfs://test",
      trading_open: bn(0),
      trading_cutoff: bn(100),
      tick: bn(10n ** 18n),
      step: bn(1),
      min_notional: bn(1),
      max_quantity: bn(100),
      max_order: bn(100),
      max_wallet: bn(200),
      max_market: bn(400),
    },
    mints,
    decimals: [6, 6],
    vaults_initialized: 63,
    state: 2,
    sequence: [bn(0), bn(0)],
    open_notional: bn(0),
    credits: Array.from({ length: 6 }, (_, a) => bn(a < 2 ? 0 : 10)),
    escrow: Array.from({ length: 6 }, () => bn(20)),
    backing: [bn(40), bn(50)],
    fees: [bn(1), bn(2), bn(3), bn(4)],
    resolution_commitment: Array(32).fill(0),
    payouts: [0, 0],
    evidence: Array(32).fill(0),
    evidence_uri: "",
    resolved_at: bn(0),
    bump: 0,
  };
  const info = (owner: PublicKey, data: Buffer): AccountInfo<Buffer> => ({
    owner,
    data,
    executable: false,
    lamports: 10_000_000,
    rentEpoch: 0,
  });
  const poolKeys = mints.slice(0, 2).map((mint) => poolAddress(config, mint, program));
  const poolStates = mints
    .slice(0, 2)
    .map((mint, i) => ({
      config,
      mint,
      token_program: TOKEN_PROGRAM_ID,
      decimals: 6,
      liability: bn(i === 0 ? 70 : 80),
      bump: 0,
    }));
  const token = (
    asset: number,
    amount: bigint,
    authority = asset < 2 ? poolKeys[asset]! : market,
    mint = mints[asset]!,
  ) => {
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
  const values: (AccountInfo<Buffer> | null)[] = [
    info(program, await coder.accounts.encode("Market", state)),
    ...[70n, 80n, 31n, 32n, 33n, 34n].map((amount, asset) => token(asset, amount)),
    ...[35n, 35n, 45n, 45n].map((amount) => claim(amount)),
  ];
  const calls: { addresses: PublicKey[]; options: unknown }[] = [];
  const client = {
    config,
    program,
    connection: {
      getMultipleAccountsInfoAndContext: async (addresses: PublicKey[], options: unknown) => {
        calls.push({ addresses, options });
        const all = new Map<string, AccountInfo<Buffer> | null>([[String(market), values[0]!]]);
        for (let a = 0; a < 2; a++) {
          all.set(
            String(poolKeys[a]),
            info(program, await coder.accounts.encode("AssetPool", poolStates[a]!)),
          );
          all.set(String(poolVaultAddress(poolKeys[a]!, program)), values[1 + a]!);
        }
        for (let a = 2; a < 6; a++) {
          all.set(String(vaultAddress(market, a, program)), values[1 + a]!);
          all.set(String(claimAddress(market, a, program)), values[5 + a]!);
        }
        return { context: { slot: 100 }, value: addresses.map((a) => all.get(String(a)) ?? null) };
      },
    },
  } as unknown as SolanaClient;
  const snapshot = {
    program,
    slot: 90,
    observedAt: Date.now(),
    config: { quote_mint: mints[1] },
    markets: new Map([
      [
        String(market),
        {
          ...state,
          backing: [...state.backing],
          credits: Array(6).fill(bn(0)),
          escrow: Array(6).fill(bn(0)),
        },
      ],
    ]),
    pools: new Map(
      poolKeys.map((p, i) => [
        String(p),
        { ...poolStates[i]!, liability: bn(i === 0 ? 40 : 50) } as AssetPoolAccount,
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
    values,
    calls,
    token,
    info,
    program,
    claim,
    snapshot,
    poolKeys,
    poolStates,
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
  expect(f.calls[0]?.options).toEqual({
    commitment: "finalized",
    minContextSlot: 90,
  });
  expect(f.calls[0]?.addresses.map(String)).toEqual(
    f.poolKeys.flatMap((p) => [p, poolVaultAddress(p, f.program)]).map(String),
  );
  expect(f.calls[1]?.addresses.map(String)).toEqual(
    [
      f.market,
      ...Array.from({ length: 4 }, (_, a) => vaultAddress(f.market, a + 2, f.program)),
      ...Array.from({ length: 4 }, (_, a) => claimAddress(f.market, a + 2, f.program)),
    ].map(String),
  );
  f.values[1] = f.token(0, 71n);
  expect((await reconcileVaults(f.client, f.snapshot)).healthy).toBe(true);
});
test("a single raw-unit shortage in any custody category fails reconciliation", async () => {
  for (const [asset, amount] of [70n, 80n, 31n, 32n, 33n, 34n].entries()) {
    const f = await fixture();
    f.values[asset + 1] = f.token(asset, amount - 1n);
    await expect(reconcileVaults(f.client, f.snapshot)).rejects.toThrow("undercollateralized");
  }
});
test("missing accounts, foreign deployment, mint and authority substitutions fail closed", async () => {
  for (const mutate of [
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.values[0] = null;
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.values[1] = null;
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.values[1] = f.token(0, 60n, publicKey());
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.values[1] = f.token(0, 60n, f.market, publicKey());
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.values[1]!.owner = publicKey();
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.values[0]!.owner = publicKey();
    },
    async (f: Awaited<ReturnType<typeof fixture>>) => {
      f.state.config = publicKey();
      f.values[0] = f.info(f.program, await coder.accounts.encode("Market", f.state));
    },
  ]) {
    const f = await fixture();
    await mutate(f);
    await expect(reconcileVaults(f.client, f.snapshot)).rejects.toThrow();
  }
});
test("a partially initialized market checks only its declared vaults", async () => {
  const f = await fixture();
  f.state.vaults_initialized = 1;
  f.state.backing = [bn(0), bn(0)];
  f.state.credits = Array(6).fill(bn(0));
  f.state.escrow = [bn(20), ...Array(5).fill(bn(0))];
  f.state.fees = Array(4).fill(bn(0));
  f.values[0] = f.info(f.program, await coder.accounts.encode("Market", f.state));
  for (let i = 3; i < 11; i++) f.values[i] = null;
  expect((await reconcileVaults(f.client, f.snapshot)).checkedVaults).toBe(2);
  const empty = { ...f.snapshot, markets: new Map(), pools: new Map() };
  expect((await reconcileVaults(f.client, empty)).checkedVaults).toBe(0);
});
test("Token-2022 withheld fees never cover spendable liabilities; claim vaults stay classic", async () => {
  const f = await fixture(),
    vault = f.values[1]!;
  const extended = Buffer.alloc(178);
  vault.data.copy(extended);
  extended[165] = 2;
  extended.writeUInt16LE(2, 166);
  extended.writeUInt16LE(8, 168);
  extended.writeBigUInt64LE(1000n, 170);
  f.values[1] = { ...vault, owner: TOKEN_2022_PROGRAM_ID, data: extended };
  f.poolStates[0]!.token_program = TOKEN_2022_PROGRAM_ID;
  expect((await reconcileVaults(f.client, f.snapshot)).healthy).toBe(true);
  extended.writeBigUInt64LE(69n, 64);
  await expect(reconcileVaults(f.client, f.snapshot)).rejects.toThrow("undercollateralized");
  extended.writeBigUInt64LE(70n, 64);
  f.values[3]!.owner = TOKEN_2022_PROGRAM_ID;
  await expect(reconcileVaults(f.client, f.snapshot)).rejects.toThrow("claim vault");
});
test("frozen custody is not advertised as ready even when fully collateralized", async () => {
  const f = await fixture();
  f.values[1]!.data[108] = 2;
  await expect(reconcileVaults(f.client, f.snapshot)).rejects.toThrow("frozen");
});

test("external claim supply cannot hide behind apparently solvent recorded custody", async () => {
  const f = await fixture();
  // Every vault still exactly covers recorded liabilities. Forty-one YES tokens
  // (including external holdings) cannot be backed by forty underlying tokens.
  f.values[7] = f.claim(41n);
  await expect(reconcileVaults(f.client, f.snapshot)).rejects.toThrow("outstanding claim supply");
  f.values[7] = f.claim(31n); // voluntary external burn creates safe excess backing
  expect((await reconcileVaults(f.client, f.snapshot)).healthy).toBe(true);
  f.values[7] = f.claim(30n); // less than the canonical claim vault itself
  await expect(reconcileVaults(f.client, f.snapshot)).rejects.toThrow("exceeds total mint supply");
});

test("resolved supply uses the payout and a conservative INVALID ceiling, including archive", async () => {
  for (const state of [6, 7]) {
    const f = await fixture();
    f.state.state = state;
    f.state.payouts = [1, 0];
    f.values[7] = f.claim(40n);
    f.values[8] = f.claim((1n << 64n) - 1n);
    f.values[0]!.data = await coder.accounts.encode("Market", f.state);
    expect((await reconcileVaults(f.client, f.snapshot)).healthy).toBe(true);
    f.state.payouts = [0, 1];
    f.values[0]!.data = await coder.accounts.encode("Market", f.state);
    await expect(reconcileVaults(f.client, f.snapshot)).rejects.toThrow("outstanding claim supply");
    f.state.payouts = [1, 1];
    f.values[8] = f.claim(41n);
    f.values[0]!.data = await coder.accounts.encode("Market", f.state);
    await expect(reconcileVaults(f.client, f.snapshot)).rejects.toThrow("outstanding claim supply");
    f.state.backing[0] = bn(41);
    f.values[1] = f.token(0, 71n);
    f.values[0]!.data = await coder.accounts.encode("Market", f.state);
    expect((await reconcileVaults(f.client, f.snapshot)).healthy).toBe(true);
    f.state.payouts = [0, 0];
    f.values[0]!.data = await coder.accounts.encode("Market", f.state);
    await expect(reconcileVaults(f.client, f.snapshot)).rejects.toThrow("Invalid finalized payout");
  }
});

test("missing, substituted, delegated, frozen and wrong-decimal claim mints fail closed", async () => {
  for (const mutate of [
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.values[7] = null;
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.values[7]!.owner = TOKEN_2022_PROGRAM_ID;
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.values[7] = f.claim(35n, publicKey());
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.values[7] = f.claim(35n, f.market, 9);
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.values[7] = f.claim(35n, f.market, 6, true);
    },
    async (f: Awaited<ReturnType<typeof fixture>>) => {
      f.state.mints[2] = publicKey();
      f.values[3] = f.token(2, 31n, f.market, f.state.mints[2]);
      f.values[0]!.data = await coder.accounts.encode("Market", f.state);
    },
  ]) {
    const f = await fixture();
    await mutate(f);
    await expect(reconcileVaults(f.client, f.snapshot)).rejects.toThrow();
  }
});

test("pool and conditional custody batching never exceeds 100 accounts", async () => {
  const first = await fixture();
  const fixtures = [
    first,
    ...(await Promise.all(
      Array.from({ length: 22 }, () =>
        fixture({ config: first.state.config, program: first.program }),
      ),
    )),
  ];
  const all = new Map<string, AccountInfo<Buffer> | null>();
  for (const f of fixtures) {
    all.set(String(f.market), f.values[0]!);
    for (let a = 0; a < 2; a++) {
      all.set(
        String(f.poolKeys[a]),
        f.info(f.program, await coder.accounts.encode("AssetPool", f.poolStates[a]!)),
      );
      all.set(String(poolVaultAddress(f.poolKeys[a]!, f.program)), f.values[1 + a]!);
    }
    for (let a = 2; a < 6; a++) {
      all.set(String(vaultAddress(f.market, a, f.program)), f.values[1 + a]!);
      all.set(String(claimAddress(f.market, a, f.program)), f.values[5 + a]!);
    }
  }
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
  expect(counts).toEqual([92, 99, 99, 9]);
  expect(result).toMatchObject({ checkedVaults: 138, checkedMints: 92, slot: "104" });
});
