import { expect, test } from "bun:test";
import { hashCanonical, normalizeGammaMarket } from "@conditional-stocks/market-data";
import {
  bn,
  claimAsset,
  coder,
  encodeAccount,
  key,
  type MarketAccount,
  multiplierBits,
  PROGRAM_ID,
  PublicKey,
  poolAddress,
  poolVaultAddress,
  SolanaClient,
  TOKEN_2022_PROGRAM_ID,
  underlyingAsset,
  unwrap,
} from "@conditional-stocks/solana-client";
import type { AccountInfo } from "@solana/web3.js";
import { gammaMarket } from "../../../packages/market-data/tests/helpers";
import { marketAccount } from "../../../packages/solana-client/test/market-fixture";
import type { EvidenceView } from "../src/lib/admin-api";
import type { MintInfo } from "../src/lib/issuer-mints";
import { buildBatchPlans, defaultMarketCaps } from "../src/lib/market-batch";
import {
  addIssuerSteps,
  creationBaseTokens,
  marketSetupSteps,
  pendingClaimSteps,
  readMarketLegs,
  setBaseAllowed,
  setBaseStep,
  setupRemaining,
} from "../src/lib/market-setup";
import {
  FIXTURE_NOW_MS,
  mintFixture,
  NVDAON,
  NVDAR,
  NVDAX,
  paused,
  tokenAccount,
} from "./issuer-fixtures";

const pubkey = () => PublicKey.unique().toBase58();
const admin = pubkey(),
  guardian = pubkey();
const deployment = {
  rpcUrl: "http://127.0.0.1:8899",
  programId: PROGRAM_ID.toBase58(),
  config: pubkey(),
  genesisHash: pubkey(),
  marketAdmin: admin,
  resolutionAdmin: admin,
};
const config = key(deployment.config),
  marketKey = PublicKey.unique(),
  quoteMint = PublicKey.unique();
const names = { [NVDAX]: "NVDAx", [NVDAON]: "NVDAon", [NVDAR]: "NVDAr" };

/** A created market that lists only the quote (create_market) with `listed` issuer legs added. */
function created(listed: string[] = [], claims: number[] = []): MarketAccount {
  const m = marketAccount({
    config,
    market: marketKey,
    legs: 1,
    quoteMint,
    state: 1,
    shareDecimals: 6,
  });
  m.bases = listed.length;
  m.mints[underlyingAsset(1)] = PublicKey.default;
  listed.forEach((mint, i) => {
    m.mints[underlyingAsset(i + 1)] = key(mint);
    m.legs[i] = { scale: bn(1), multiplier: bn(multiplierBits(1)), active: true };
  });
  for (let i = listed.length; i < 3; i++)
    m.legs[i] = { scale: bn(0), multiplier: bn(0), active: false };
  m.vaults_initialized = 1;
  for (const c of claims) m.vaults_initialized |= (1 << claimAsset(c, 0)) | (1 << claimAsset(c, 1));
  for (let c = 1; c <= listed.length; c++) m.vaults_initialized |= 1 << underlyingAsset(c);
  return m;
}
const pool = (mint: string, admitted: number): AccountInfo<Buffer> => ({
  data: encodeAccount("AssetPool", {
    config,
    mint: key(mint),
    token_program: TOKEN_2022_PROGRAM_ID,
    liability: bn(0),
    decimals: 9,
    bump: 255,
    admitted,
    vault_bump: 255,
  }),
  owner: PROGRAM_ID,
  executable: false,
  lamports: 1,
  rentEpoch: 0,
});
const poolOf = (mint: string) => poolAddress(config, key(mint), PROGRAM_ID);
function chain(market: MarketAccount, accounts: Record<string, AccountInfo<Buffer> | null> = {}) {
  const client = new SolanaClient(deployment);
  const all: Record<string, AccountInfo<Buffer> | null> = {
    [NVDAX]: mintFixture(NVDAX),
    [NVDAON]: mintFixture(NVDAON),
    [NVDAR]: mintFixture(NVDAR),
    ...accounts,
  };
  const read = (k: PublicKey) => all[k.toBase58()] ?? null;
  client.assertNetwork = async () => {};
  client.market = async () => market;
  client.configAccount = async () =>
    ({
      quote_mint: quoteMint,
      roles: { market_admin: key(admin), guardian: key(guardian), resolution_admin: key(admin) },
    }) as Awaited<ReturnType<SolanaClient["configAccount"]>>;
  client.connection.getAccountInfo = async (k) => read(k);
  client.connection.getMultipleAccountsInfo = async (keys) => keys.map(read);
  return client;
}
const decoded = (step: { transaction: Parameters<typeof unwrap>[0] }) =>
  unwrap(step.transaction).map((ix) => {
    const value = coder.instruction.decode(ix.data)!;
    return { name: value.name, data: value.data as Record<string, unknown>, keys: ix.keys };
  });

test("after create-market, setup lists every issuer in evidence order (pool with exact admission + add_base), then claims per collateral", async () => {
  const steps = await marketSetupSteps(
    chain(created()),
    marketKey.toBase58(),
    admin,
    [NVDAX, NVDAON, NVDAR],
    names,
  );
  expect(steps.map((step) => step.title)).toEqual([
    "List issuer token",
    "List issuer token",
    "List issuer token",
    "Create claim mints",
    "Create claim mints",
    "Create claim mints",
    "Create claim mints",
  ]);
  const ixs = steps.map(decoded);
  [NVDAX, NVDAON, NVDAR].forEach((mint, i) => {
    expect(ixs[i]!.map((ix) => ix.name)).toEqual(["initialize_pool", "add_base"]);
    expect(ixs[i]![0]!.data.admitted).toBe([63, 62, 47][i]);
    expect(ixs[i]![1]!.keys.some((meta) => meta.pubkey.toBase58() === mint)).toBe(true);
  });
  expect(ixs.slice(3).map((tx) => tx[0]!.data.collateral)).toEqual([0, 1, 2, 3]);
  expect(steps.every((step) => step.transaction.from === admin)).toBe(true);
  expect(steps[0]!.details[0]).toContain("NVDAx admitting issuer controls 63");
  expect(steps[0]!.details[0]).toContain("permanentDelegate");
  expect(steps[1]!.details[1]).toBe("List NVDAon as the next issuer leg (add_base)");
  expect(steps[3]!.details[0]).toContain("quote YES/NO claim mints");
  expect(steps[6]!.details[0]).toContain("initialize_claims 3");
});

test("setup resumes from chain state, reuses existing pools, and refuses listed legs or pools that differ", async () => {
  const partial = created([NVDAX], [0, 1]);
  const steps = await marketSetupSteps(
    chain(partial, { [poolOf(NVDAON).toBase58()]: pool(NVDAON, 62) }),
    marketKey.toBase58(),
    admin,
    [NVDAX, NVDAON, NVDAR],
  );
  expect(steps.map((step) => decoded(step).map((ix) => ix.name))).toEqual([
    ["add_base"],
    ["initialize_pool", "add_base"],
    ["initialize_claims"],
    ["initialize_claims"],
  ]);
  expect(steps.slice(2).map((step) => decoded(step)[0]!.data.collateral)).toEqual([2, 3]);
  expect(setupRemaining(partial, [NVDAX, NVDAON, NVDAR])).toEqual({
    missingLegs: 2,
    missingClaims: 2,
    complete: false,
  });
  expect(setupRemaining(created([NVDAX, NVDAON], [0, 1, 2]), [NVDAX, NVDAON]).complete).toBe(true);
  expect(setupRemaining(created([], [0]), []).complete).toBe(false);
  await expect(
    marketSetupSteps(chain(partial), marketKey.toBase58(), admin, [NVDAON, NVDAX]),
  ).rejects.toThrow("differ from the market evidence");
  await expect(
    marketSetupSteps(
      chain(created(), { [poolOf(NVDAX).toBase58()]: pool(NVDAX, 62) }),
      marketKey.toBase58(),
      admin,
      [NVDAX],
    ),
  ).rejects.toThrow("issuer configuration changed");
});

test("creation evidence gives the ordered issuer tokens of a market; rejected, unrelated or conflicting packets do not", () => {
  const raw = gammaMarket(),
    source = {
      normalized: normalizeGammaMarket(raw),
      rawHash: hashCanonical(raw),
      snapshotId: "s",
    };
  const leg = (address: string, decimals: number): MintInfo => ({
    address,
    decimals,
    standard: "Token-2022",
    symbol: null,
    name: null,
    issuer: {
      controls: 0,
      controlNames: [],
      paused: false,
      defaultFrozen: false,
      transferHookExtension: false,
      multiplier: "4607182418800017408",
      multiplierValue: 1,
      nextMultiplier: null,
    },
  });
  const nowMs = Date.parse("2026-09-13T00:00:00Z");
  const [nvda, other] = buildBatchPlans({
    deployment,
    owner: admin,
    source,
    quote: leg(quoteMint.toBase58(), 6),
    nowMs,
    shared: {
      tradingOpen: String(nowMs / 1000),
      tradingCutoff: "1798761600",
      metadataUri: source.normalized.canonicalUrl,
      sourceUrls: source.normalized.canonicalUrl,
    },
    rows: [
      {
        legs: [leg(NVDAX, 8), leg(NVDAON, 9), leg(NVDAR, 9)],
        shareDecimals: 6,
        caps: defaultMarketCaps(6, 6),
      },
      { legs: [leg(pubkey(), 6)], shareDecimals: 6, caps: defaultMarketCaps(6, 6) },
    ],
  });
  const view = (plan: typeof nvda, status: EvidenceView["status"] = "approved"): EvidenceView => ({
    envelope: plan!.envelope,
    status,
    reviews: [],
    previews: [],
    observations: [],
  });
  expect(creationBaseTokens([view(other), view(nvda)], nvda!.expectedMarketId, deployment)).toEqual(
    [NVDAX, NVDAON, NVDAR],
  );
  expect(
    creationBaseTokens([view(nvda, "rejected")], nvda!.expectedMarketId, deployment),
  ).toBeNull();
  expect(creationBaseTokens([view(other)], nvda!.expectedMarketId, deployment)).toBeNull();
  expect(
    creationBaseTokens([view(nvda)], nvda!.expectedMarketId, { ...deployment, config: pubkey() }),
  ).toBeNull();
});

test("adding an issuer checks role, leg limit, state, cutoff, duplicates and the token, then lists it and creates its claims", async () => {
  const base = () => {
    const m = created([NVDAX], [0, 1]);
    m.state = 2;
    return m;
  };
  const id = marketKey.toBase58();
  const add = (mint: string, market = base(), actor = admin, accounts = {}) =>
    addIssuerSteps(chain(market, accounts), id, actor, mint, FIXTURE_NOW_MS);
  const { steps, symbol } = await add(NVDAON);
  expect(symbol).toBe("NVDAon");
  expect(steps.map((step) => decoded(step).map((ix) => ix.name))).toEqual([
    ["initialize_pool", "add_base"],
    ["initialize_claims"],
  ]);
  expect(decoded(steps[0]!)[0]!.data.admitted).toBe(62);
  expect(decoded(steps[1]!)[0]!.data.collateral).toBe(2);
  expect(steps[0]!.details[1]).toBe("List NVDAon as the next issuer leg (add_base)");
  await expect(add(NVDAON, base(), guardian)).rejects.toThrow("Only the market admin");
  await expect(add(NVDAX)).rejects.toThrow("already listed");
  await expect(add(quoteMint.toBase58())).rejects.toThrow("quote token");
  const full = created([NVDAX, NVDAON, NVDAR], [0, 1, 2, 3]);
  await expect(add(pubkey(), full)).rejects.toThrow("at most 3");
  const frozen = base();
  frozen.state = 3;
  await expect(add(NVDAON, frozen)).rejects.toThrow("scheduled or open");
  const late = base();
  late.terms.trading_cutoff = bn(FIXTURE_NOW_MS / 1000);
  await expect(add(NVDAON, late)).rejects.toThrow("cutoff");
  const precise = base();
  precise.terms.share_decimals = 10;
  await expect(add(NVDAON, precise)).rejects.toThrow("fewer than");
  const pausedMint = pubkey();
  await expect(
    add(pausedMint, base(), admin, { [pausedMint]: paused(mintFixture(NVDAON)) }),
  ).rejects.toThrow("paused");
  // An interrupted sequence (listed, claims missing) resumes with only the claim step.
  const interrupted = created([NVDAX, NVDAON], [0, 1]);
  interrupted.state = 2;
  const resumed = await add(NVDAON, interrupted);
  expect(resumed.steps.map((step) => decoded(step)[0]!.data.collateral)).toEqual([2]);
  expect((await pendingClaimSteps(chain(interrupted), id, pubkey())).map((s) => s.title)).toEqual([
    "Create claim mints",
  ]);
});

test("the guardian may only delist; the market admin may delist or relist; set_base carries the leg and flag", async () => {
  const market = created([NVDAX, NVDAON], [0, 1, 2]);
  market.legs[1]!.active = false;
  const view = await readMarketLegs(chain(market), marketKey.toBase58(), FIXTURE_NOW_MS);
  const roles = view.roles;
  expect(setBaseAllowed(guardian, roles, false)).toBe(true);
  expect(setBaseAllowed(guardian, roles, true)).toBe(false);
  expect(setBaseAllowed(admin, roles, true)).toBe(true);
  expect(setBaseAllowed(pubkey(), roles, false)).toBe(false);
  expect(setBaseAllowed(null, roles, false)).toBe(false);
  const id = marketKey.toBase58();
  const [delist] = setBaseStep(deployment, guardian, view, id, 1, false);
  expect(delist!.transaction.from).toBe(guardian);
  expect(decoded(delist!)[0]).toMatchObject({
    name: "set_base",
    data: { collateral: 1, active: false },
  });
  expect(delist!.details[0]).toBe("Delist issuer leg 1 (set_base)");
  expect(() => setBaseStep(deployment, guardian, view, id, 2, true)).toThrow(
    "Only the market admin",
  );
  const [relist] = setBaseStep(deployment, admin, view, id, 2, true);
  expect(decoded(relist!)[0]).toMatchObject({
    name: "set_base",
    data: { collateral: 2, active: true },
  });
  expect(() => setBaseStep(deployment, admin, view, id, 1, true)).toThrow("already listed");
  expect(() => setBaseStep(deployment, admin, view, id, 3, false)).toThrow("Unknown issuer leg");
});

test("listed legs show symbol, decimals, scale, listing vs live multiplier, readiness and the SDK halt reason", async () => {
  const market = created([NVDAX, NVDAON, NVDAR], [0, 1, 2]);
  market.decimals = [6, 8, 9, 9];
  market.legs[0] = {
    scale: bn(100),
    multiplier: bn(multiplierBits(1.0009180758490996)),
    active: true,
  };
  market.legs[1] = {
    scale: bn(1000),
    multiplier: bn(multiplierBits(1.0017152487959897)),
    active: true,
  };
  market.legs[2] = { scale: bn(1000), multiplier: bn(multiplierBits(1)), active: false };
  const vault = (mint: string) => poolVaultAddress(poolOf(mint), PROGRAM_ID).toBase58();
  const client = chain(market, {
    [vault(NVDAX)]: tokenAccount(1, TOKEN_2022_PROGRAM_ID),
    [vault(NVDAON)]: tokenAccount(2, TOKEN_2022_PROGRAM_ID),
    [vault(NVDAR)]: tokenAccount(1, TOKEN_2022_PROGRAM_ID),
  });
  const view = await readMarketLegs(client, marketKey.toBase58(), FIXTURE_NOW_MS);
  expect(view.shareDecimals).toBe(6);
  expect(view.roles).toEqual({ marketAdmin: admin, guardian });
  expect(view.legs.map((leg) => leg.symbol)).toEqual(["NVDAx", "NVDAon", "NVDAr"]);
  expect(view.legs.map((leg) => [leg.decimals, leg.scale])).toEqual([
    [8, 100n],
    [9, 1000n],
    [9, 1000n],
  ]);
  expect(view.legs[0]!.listingMultiplierValue).toBe(1.0009180758490996);
  expect(view.legs[0]!.multiplierValue).toBe(1.001701196801074);
  expect(view.legs[0]!.tradable).toBe(true);
  expect(view.legs[1]!.halt).toBe("vault-frozen");
  expect(view.legs[2]!.halt).toBe("delisted");
  expect(view.legs[2]!.ready).toBe(false);
});
