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
} from "@conditional-stocks/solana-client";
import { reconcileVaults } from "../src/reconcile.ts";

const publicKey = () => Keypair.generate().publicKey;
async function fixture(domain?: { config: PublicKey; program: PublicKey }) {
  const config = domain?.config ?? publicKey(),
    program = domain?.program ?? publicKey(),
    market = publicKey(),
    mints = [
      publicKey(),
      publicKey(),
      ...Array.from({ length: 4 }, (_, a) =>
        claimAddress(market, a + 2, program),
      ),
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
    credits: Array.from({ length: 6 }, () => bn(10)),
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
  const token = (
    asset: number,
    amount: bigint,
    authority = market,
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
  const claim = (
    supply: bigint,
    authority = market,
    decimals = 6,
    freeze = false,
  ) => {
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
    ...[70n, 80n, 31n, 32n, 33n, 34n].map((amount, asset) =>
      token(asset, amount),
    ),
    ...[35n, 35n, 45n, 45n].map((amount) => claim(amount)),
  ];
  const calls: { addresses: PublicKey[]; options: unknown }[] = [];
  const client = {
    config,
    program,
    connection: {
      getMultipleAccountsInfoAndContext: async (
        addresses: PublicKey[],
        options: unknown,
      ) => {
        calls.push({ addresses, options });
        return { context: { slot: 100 }, value: values };
      },
    },
  } as unknown as SolanaClient;
  return { client, state, market, values, calls, token, info, program, claim };
}

test("all six liabilities use one finalized bank, including whole backing and claim fees", async () => {
  const f = await fixture(),
    report = await reconcileVaults(f.client, [f.market.toBase58()], 90);
  expect(report).toMatchObject({
    healthy: true,
    checkedVaults: 6,
    checkedMints: 4,
    slot: "100",
  });
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]?.options).toEqual({
    commitment: "finalized",
    minContextSlot: 90,
  });
  expect(f.calls[0]?.addresses.map((k) => k.toBase58())).toEqual(
    [
      f.market,
      ...Array.from({ length: 6 }, (_, a) =>
        vaultAddress(f.market, a, f.program),
      ),
      ...Array.from({ length: 4 }, (_, a) =>
        claimAddress(f.market, a + 2, f.program),
      ),
    ].map((k) => k.toBase58()),
  );
  f.values[1] = f.token(0, 71n);
  expect(
    (await reconcileVaults(f.client, [f.market.toBase58()], 90)).healthy,
  ).toBe(true);
});
test("a single raw-unit shortage in any custody category fails reconciliation", async () => {
  for (const [asset, amount] of [70n, 80n, 31n, 32n, 33n, 34n].entries()) {
    const f = await fixture();
    f.values[asset + 1] = f.token(asset, amount - 1n);
    await expect(
      reconcileVaults(f.client, [f.market.toBase58()], 90),
    ).rejects.toThrow("undercollateralized");
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
      f.values[0] = f.info(
        f.program,
        await coder.accounts.encode("Market", f.state),
      );
    },
  ]) {
    const f = await fixture();
    await mutate(f);
    await expect(
      reconcileVaults(f.client, [f.market.toBase58()], 90),
    ).rejects.toThrow();
  }
});
test("a partially initialized market checks only its declared vaults", async () => {
  const f = await fixture();
  f.state.vaults_initialized = 1;
  f.state.backing = [bn(0), bn(0)];
  f.state.credits = [bn(10), ...Array(5).fill(bn(0))];
  f.state.escrow = [bn(20), ...Array(5).fill(bn(0))];
  f.state.fees = Array(4).fill(bn(0));
  f.values[0] = f.info(
    f.program,
    await coder.accounts.encode("Market", f.state),
  );
  for (let i = 2; i < 11; i++) f.values[i] = null;
  expect(
    (await reconcileVaults(f.client, [f.market.toBase58()], 90)).checkedVaults,
  ).toBe(1);
  expect((await reconcileVaults(f.client, [], 90)).checkedVaults).toBe(0);
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
  expect(
    (await reconcileVaults(f.client, [f.market.toBase58()], 90)).healthy,
  ).toBe(true);
  extended.writeBigUInt64LE(69n, 64);
  await expect(
    reconcileVaults(f.client, [f.market.toBase58()], 90),
  ).rejects.toThrow("undercollateralized");
  extended.writeBigUInt64LE(70n, 64);
  f.values[3]!.owner = TOKEN_2022_PROGRAM_ID;
  await expect(
    reconcileVaults(f.client, [f.market.toBase58()], 90),
  ).rejects.toThrow("claim vault");
});
test("frozen custody is not advertised as ready even when fully collateralized", async () => {
  const f = await fixture();
  f.values[1]!.data[108] = 2;
  await expect(
    reconcileVaults(f.client, [f.market.toBase58()], 90),
  ).rejects.toThrow("frozen");
});

test("external claim supply cannot hide behind apparently solvent recorded custody", async () => {
  const f = await fixture();
  // Every vault still exactly covers recorded liabilities. Forty-one YES tokens
  // (including external holdings) cannot be backed by forty underlying tokens.
  f.values[7] = f.claim(41n);
  await expect(
    reconcileVaults(f.client, [f.market.toBase58()], 90),
  ).rejects.toThrow("outstanding claim supply");
  f.values[7] = f.claim(31n); // voluntary external burn creates safe excess backing
  expect(
    (await reconcileVaults(f.client, [f.market.toBase58()], 90)).healthy,
  ).toBe(true);
  f.values[7] = f.claim(30n); // less than the canonical claim vault itself
  await expect(
    reconcileVaults(f.client, [f.market.toBase58()], 90),
  ).rejects.toThrow("exceeds total mint supply");
});

test("resolved supply uses the payout and a conservative INVALID ceiling, including archive", async () => {
  for (const state of [6, 7]) {
    const f = await fixture();
    f.state.state = state;
    f.state.payouts = [1, 0];
    f.values[7] = f.claim(40n);
    f.values[8] = f.claim((1n << 64n) - 1n);
    f.values[0]!.data = await coder.accounts.encode("Market", f.state);
    expect(
      (await reconcileVaults(f.client, [f.market.toBase58()], 90)).healthy,
    ).toBe(true);
    f.state.payouts = [0, 1];
    f.values[0]!.data = await coder.accounts.encode("Market", f.state);
    await expect(
      reconcileVaults(f.client, [f.market.toBase58()], 90),
    ).rejects.toThrow("outstanding claim supply");
    f.state.payouts = [1, 1];
    f.values[8] = f.claim(41n);
    f.values[0]!.data = await coder.accounts.encode("Market", f.state);
    await expect(
      reconcileVaults(f.client, [f.market.toBase58()], 90),
    ).rejects.toThrow("outstanding claim supply");
    f.state.backing[0] = bn(41);
    f.values[1] = f.token(0, 71n);
    f.values[0]!.data = await coder.accounts.encode("Market", f.state);
    expect(
      (await reconcileVaults(f.client, [f.market.toBase58()], 90)).healthy,
    ).toBe(true);
    f.state.payouts = [0, 0];
    f.values[0]!.data = await coder.accounts.encode("Market", f.state);
    await expect(
      reconcileVaults(f.client, [f.market.toBase58()], 90),
    ).rejects.toThrow("Invalid finalized payout");
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
    await expect(
      reconcileVaults(f.client, [f.market.toBase58()], 90),
    ).rejects.toThrow();
  }
});

test("claim supply and custody batching never exceed 100 accounts or use separate snapshots", async () => {
  const first = await fixture();
  const fixtures = [
    first,
    ...(await Promise.all(
      Array.from({ length: 9 }, () =>
        fixture({ config: first.state.config, program: first.program }),
      ),
    )),
  ];
  const all = new Map<string, AccountInfo<Buffer> | null>();
  for (const f of fixtures) {
    const addresses = [
      f.market,
      ...Array.from({ length: 6 }, (_, a) =>
        vaultAddress(f.market, a, f.program),
      ),
      ...Array.from({ length: 4 }, (_, a) =>
        claimAddress(f.market, a + 2, f.program),
      ),
    ];
    addresses.forEach((key, i) => all.set(key.toBase58(), f.values[i]!));
  }
  const counts: number[] = [];
  first.client.connection.getMultipleAccountsInfoAndContext = async (
    addresses,
    options,
  ) => {
    counts.push(addresses.length);
    expect(options).toEqual({ commitment: "finalized", minContextSlot: 90 });
    return {
      context: { slot: 100 + counts.length },
      value: addresses.map((a) => all.get(a.toBase58()) ?? null),
    };
  };
  const result = await reconcileVaults(
    first.client,
    fixtures.map((f) => f.market.toBase58()),
    90,
  );
  expect(counts).toEqual([99, 11]);
  expect(result).toMatchObject({
    checkedVaults: 60,
    checkedMints: 40,
    slot: "102",
  });
});
