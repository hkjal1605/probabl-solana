import { expect, test } from "bun:test";
import { hashCanonical, normalizeGammaMarket } from "@conditional-stocks/market-data";
import {
  big,
  bn,
  coder,
  encodeAccount,
  key,
  marketAddress,
  PROGRAM_ID,
  PublicKey,
  poolAddress,
  poolVaultAddress,
  SolanaClient,
  TOKEN_2022_PROGRAM_ID,
  unwrap,
} from "@conditional-stocks/solana-client";
import { evidenceTransaction, marketIdFromConfig } from "@conditional-stocks/solana-client/admin";
import { buildCreationEvidence } from "@conditional-stocks/solana-client/evidence";
import type { AccountInfo } from "@solana/web3.js";
import { gammaMarket } from "../../../packages/market-data/tests/helpers";
import type { EvidenceView } from "../src/lib/admin-api";
import { dateTimeInputToUnixSeconds } from "../src/lib/date-time";
import type { MintInfo } from "../src/lib/issuer-mints";
import {
  assertBatchPacket,
  type BatchPlan,
  type BatchResult,
  buildBatchPlans,
  defaultMarketCaps,
  loadBatchMints,
  MAX_BATCH_MARKETS,
  type MarketCaps,
  mintIdentity,
  parseAssetRows,
  parseIssuerMints,
  prepareMarketBatch,
  recoverBatchResults,
  resolveRows,
  validateMarketCaps,
} from "../src/lib/market-batch";
import {
  defaultFrozen,
  FIXTURE_NOW_MS,
  hookSet,
  mintFixture,
  NVDAON,
  NVDAR,
  NVDAX,
  paused,
  splMint,
  tokenAccount,
} from "./issuer-fixtures";

const pubkey = () => PublicKey.unique().toBase58();
const U64 = (1n << 64n) - 1n,
  U128 = (1n << 128n) - 1n,
  WAD = 10n ** 18n;
const deployment = {
  rpcUrl: "http://127.0.0.1:8899",
  programId: PROGRAM_ID.toBase58(),
  config: pubkey(),
  genesisHash: pubkey(),
  marketAdmin: pubkey(),
  resolutionAdmin: pubkey(),
};
const source = {
  normalized: normalizeGammaMarket(gammaMarket()),
  rawHash: hashCanonical(gammaMarket()),
  snapshotId: "batch-snapshot",
};
const issuer = (overrides: Partial<MintInfo["issuer"]> = {}): MintInfo["issuer"] => ({
  controls: 0,
  controlNames: [],
  paused: false,
  defaultFrozen: false,
  transferHookExtension: false,
  multiplier: "4607182418800017408",
  multiplierValue: 1,
  nextMultiplier: null,
  ...overrides,
});
const mintInfo = (decimals: number, overrides: Partial<MintInfo> = {}): MintInfo => ({
  address: pubkey(),
  decimals,
  standard: "Token-2022",
  symbol: null,
  name: null,
  issuer: issuer(),
  ...overrides,
});
const quote = mintInfo(6, { standard: "SPL Token" });
const nowMs = Date.parse("2026-09-13T00:00:00Z");
const shared = {
  tradingOpen: String(nowMs / 1000),
  tradingCutoff: "1798761600",
  metadataUri: source.normalized.canonicalUrl,
  sourceUrls: source.normalized.canonicalUrl,
};
/** Two asset markets of one event: NVDA with three issuer legs (8/9/9 decimals), TSLA with one. */
const makeInput = () => ({
  deployment,
  owner: deployment.marketAdmin,
  source,
  quote,
  shared,
  nowMs,
  rows: [
    {
      legs: [mintInfo(8), mintInfo(9), mintInfo(9)],
      shareDecimals: 6,
      caps: defaultMarketCaps(6, 6),
    },
    { legs: [mintInfo(6)], shareDecimals: 6, caps: defaultMarketCaps(6, 6) },
    { legs: [mintInfo(9), mintInfo(8)], shareDecimals: 8, caps: defaultMarketCaps(8, 6) },
  ],
});
const plans = () => buildBatchPlans(makeInput());
const pending = (batch: BatchPlan[]): BatchResult[] => batch.map(() => ({ phase: "pending" }));
const packet = (plan: BatchPlan): EvidenceView => ({
  envelope: buildCreationEvidence({
    deployment,
    preparer: deployment.marketAdmin,
    preparedAt: new Date(nowMs + 5000).toISOString(),
    ...plan.body,
    metadata: source.normalized,
    metadataRawHash: source.rawHash,
  }),
  status: "prepared",
  reviews: [],
  previews: [],
  observations: [],
});

test("each market row takes 1–3 distinct issuer mints; a batch takes 1–20 markets and never shares an issuer token", () => {
  const keys = Array.from({ length: 4 }, pubkey);
  expect(parseIssuerMints(`  ${keys[0]},\n${keys[1]} \t${keys[2]}`)).toEqual(keys.slice(0, 3));
  for (const input of [
    "",
    " \n,",
    "NVDAx",
    "https://example.com/mint",
    keys[0] + "," + keys[0],
    keys.join(" "),
  ])
    expect(() => parseIssuerMints(input)).toThrow();
  const rows = Array.from({ length: MAX_BATCH_MARKETS }, () => `${pubkey()}\n${pubkey()}`);
  expect(parseAssetRows(rows)).toHaveLength(MAX_BATCH_MARKETS);
  expect(() => parseAssetRows([...rows, pubkey()])).toThrow("between 1 and");
  expect(() => parseAssetRows([])).toThrow();
  expect(() => parseAssetRows([keys[0]!, `${keys[1]}\n${keys[0]}`])).toThrow(
    "more than one market",
  );
  expect(() => parseAssetRows([keys[0]!, keys.join("\n")])).toThrow("Market 2");
});

test("defaults scale base quantities and price ticks independently for stocks, BTC, ETH and wrapped SOL", () => {
  for (const decimals of [0, 2, 6, 8, 9, 18]) {
    const caps = defaultMarketCaps(decimals, 6);
    expect(() => validateMarketCaps(caps)).not.toThrow();
    expect(BigInt(caps.maxOrderQuantity) % BigInt(caps.baseStep)).toBe(0n);
    expect(caps.minNotional).toBe("1000000");
    expect(caps.maxOrderNotional).toBe("10000000000");
  }
  expect(defaultMarketCaps(6, 6).baseStep).toBe("1000");
  expect(defaultMarketCaps(8, 6).baseStep).toBe("100000");
  expect(defaultMarketCaps(9, 6).baseStep).toBe("1000000");
  expect(defaultMarketCaps(6, 6).priceTickRawX18).toBe("10000000000000000");
  expect(defaultMarketCaps(8, 6).priceTickRawX18).toBe("100000000000000");
  expect(defaultMarketCaps(9, 6).priceTickRawX18).toBe("10000000000000");
});

test("unusual decimals never produce fractional or out-of-range raw defaults; unsafe combinations still require valid caps", () => {
  for (const base of [0, 1, 6, 9, 18, 19, 20, 255])
    for (const quote of [0, 6, 18, 255]) {
      for (const [field, value] of Object.entries(defaultMarketCaps(base, quote))) {
        expect(BigInt(value)).toBeGreaterThan(0n);
        expect(BigInt(value)).toBeLessThanOrEqual(field === "priceTickRawX18" ? U128 : U64);
      }
    }
  for (const decimals of [-1, 256, 6.5, NaN, Infinity]) {
    expect(() => defaultMarketCaps(decimals, 6)).toThrow();
    expect(() => defaultMarketCaps(6, decimals)).toThrow();
  }
  expect(() => validateMarketCaps(defaultMarketCaps(0, 255))).toThrow();
});

test("caps reject noncanonical, zero, fractional and overflowing integers in every amount field", () => {
  const caps = defaultMarketCaps(6, 6);
  for (const field of Object.keys(caps) as (keyof MarketCaps)[]) {
    for (const value of [
      "0",
      "-1",
      "1.5",
      "1e6",
      "01",
      " 1",
      "",
      "NaN",
      "9".repeat(100),
      String((field === "priceTickRawX18" ? U128 : U64) + 1n),
    ])
      expect(() => validateMarketCaps({ ...caps, [field]: value })).toThrow();
  }
});

test("cap ordering, dust, quote overflow and room for both counterparties are enforced", () => {
  const caps = defaultMarketCaps(6, 6);
  for (const change of [
    { maxOrderQuantity: "1" },
    { minNotional: "10000000001" },
    { maxWalletOpenNotional: "1" },
    { maxMarketOpenNotional: "1" },
    { priceTickRawX18: "1" },
    { priceTickRawX18: String(U128) },
  ])
    expect(() => validateMarketCaps({ ...caps, ...change })).toThrow();
  const tight = {
    baseStep: "1",
    priceTickRawX18: String(WAD + 1n),
    maxOrderQuantity: "1",
    minNotional: "1",
    maxOrderNotional: "2",
    maxWalletOpenNotional: "2",
    maxMarketOpenNotional: "4",
  };
  expect(() => validateMarketCaps(tight)).not.toThrow();
  expect(() => validateMarketCaps({ ...tight, maxMarketOpenNotional: "3" })).toThrow();
  expect(() => validateMarketCaps({ ...tight, maxOrderNotional: "1" })).toThrow();
  expect(() =>
    validateMarketCaps({
      ...tight,
      priceTickRawX18: String(U64 * WAD + 1n),
      maxOrderNotional: String(U64),
      maxWalletOpenNotional: String(U64),
      maxMarketOpenNotional: String(U64),
    }),
  ).toThrow();
});

test("each asset market lists its ordered issuer legs as schema-4 evidence and derives its PDA from marketIdFromConfig", () => {
  const input = makeInput(),
    batch = buildBatchPlans(input);
  expect(new Set(batch.map((plan) => plan.expectedMarketId)).size).toBe(3);
  expect(
    buildBatchPlans({ ...input, nowMs: nowMs + 1000 }).map((plan) => plan.expectedMarketId),
  ).toEqual(batch.map((plan) => plan.expectedMarketId));
  batch.forEach((plan, index) => {
    const row = input.rows[index]!,
      config = plan.envelope.packet.config;
    expect(plan.envelope.packet.schemaVersion).toBe(4);
    expect(config.baseTokens).toEqual(row.legs.map((leg) => leg.address));
    expect(plan.baseTokens).toEqual(config.baseTokens);
    expect(config.shareDecimals).toBe(String(row.shareDecimals));
    expect(plan.body.config.baseTokens).toEqual(config.baseTokens);
    expect(plan.body.config.shareDecimals).toBe(String(row.shareDecimals));
    expect("baseToken" in plan.body.config).toBe(false);
    expect("baseToken" in config).toBe(false);
    expect(config.baseStep).toBe(row.caps.baseStep);
    expect(plan.body.metadataSnapshotId).toBe(source.snapshotId);
    expect(config.polymarketConditionId).toBe(source.normalized.conditionId);
    expect(config.quoteToken).toBe(quote.address);
    expect(plan.expectedMarketId).toBe(
      marketAddress(key(deployment.config), marketIdFromConfig(config), PROGRAM_ID).toBase58(),
    );
    const transaction = evidenceTransaction(plan.envelope, "create-market", deployment);
    expect(transaction.expectedMarketId).toBe(plan.expectedMarketId);
    const instruction = coder.instruction.decode(unwrap(transaction)[0]!.data)!;
    expect(instruction.name).toBe("create_market");
    const terms = (instruction.data as any).terms;
    expect(big(terms.step)).toBe(BigInt(row.caps.baseStep));
    expect(big(terms.max_quantity)).toBe(BigInt(row.caps.maxOrderQuantity));
    expect(terms.share_decimals).toBe(row.shareDecimals);
  });
  // Leg order is part of the market identity.
  const reordered = makeInput();
  reordered.rows = [{ ...input.rows[0]!, legs: [...input.rows[0]!.legs].reverse() }];
  expect(buildBatchPlans(reordered)[0]!.expectedMarketId).not.toBe(batch[0]!.expectedMarketId);
});

test("readable UTC edits remain exact Unix seconds in every API body and Solana instruction", () => {
  const input = makeInput();
  input.shared = {
    ...input.shared,
    tradingOpen: dateTimeInputToUnixSeconds("2026-09-13T12:34:56"),
    tradingCutoff: dateTimeInputToUnixSeconds("2027-01-01T23:59:57"),
  };
  for (const plan of buildBatchPlans(input)) {
    expect(plan.body.config.tradingOpen).toBe("1789302896");
    expect(plan.body.config.tradingCutoff).toBe("1798847997");
    const ix = unwrap(evidenceTransaction(plan.envelope, "create-market", deployment))[0];
    if (!ix) throw new Error("Missing creation instruction");
    const decoded = coder.instruction.decode(ix.data);
    if (!decoded) throw new Error("Invalid creation instruction");
    const { terms } = decoded.data as {
      terms: { trading_open: { toString(): string }; trading_cutoff: { toString(): string } };
    };
    expect(terms.trading_open.toString()).toBe(input.shared.tradingOpen);
    expect(terms.trading_cutoff.toString()).toBe(input.shared.tradingCutoff);
  }
});

test("invalid rows, legs, share decimals, role, timestamps, missing source URLs and excessive URI length fail before writes", () => {
  const input = makeInput(),
    [nvda, tsla] = input.rows as [(typeof input.rows)[0], (typeof input.rows)[0]];
  const cases: [Partial<ReturnType<typeof makeInput>>, string?][] = [
    [{ rows: [] }],
    [{ rows: [nvda, nvda] }, "more than one market"],
    [{ rows: [{ ...nvda, legs: [...nvda.legs, mintInfo(9)] }] }, "1 to 3"],
    [{ rows: [{ ...nvda, legs: [] }] }],
    [{ rows: [{ ...nvda, legs: [nvda.legs[0]!, nvda.legs[0]!] }] }, "Duplicate"],
    [{ rows: [{ ...tsla, legs: [quote] }] }, "quote token"],
    [{ rows: [{ ...nvda, shareDecimals: 9 }] }, "fewer than the market's 9 share decimals"],
    [{ rows: [{ ...nvda, shareDecimals: 19 }] }, "Share decimals"],
    [{ rows: [{ ...tsla, legs: [mintInfo(6, { issuer: issuer({ paused: true }) })] }] }, "paused"],
    [
      { rows: [{ ...tsla, legs: [mintInfo(6, { issuer: issuer({ defaultFrozen: true }) })] }] },
      "allowlist and thaw",
    ],
    [{ owner: pubkey() }],
    [{ shared: { ...shared, tradingCutoff: shared.tradingOpen } }],
    [{ shared: { ...shared, tradingCutoff: String(nowMs / 1000 - 1) } }],
    [{ shared: { ...shared, tradingCutoff: "999999999999999999999" } }],
    [{ shared: { ...shared, tradingOpen: "-1" } }],
    [{ shared: { ...shared, sourceUrls: "" } }],
    [{ shared: { ...shared, metadataUri: "https://example.com/" + "x".repeat(512) } }],
    [{ rows: [nvda, { ...tsla, caps: { ...tsla.caps, minNotional: "0" } }] }],
  ];
  for (const [change, message] of cases) {
    const build = () => buildBatchPlans({ ...input, ...change });
    if (message) expect(build).toThrow(message);
    else expect(build).toThrow();
  }
  // A default-frozen mint whose existing pool vault the issuer already thawed may be listed.
  const thawed = mintInfo(6, {
    issuer: issuer({ defaultFrozen: true }),
    pool: { admitted: 4, vault: pubkey(), vaultFrozen: false },
  });
  thawed.issuer.controls = 4;
  expect(() => buildBatchPlans({ ...input, rows: [{ ...tsla, legs: [thawed] }] })).not.toThrow();
  // A pool that admits other issuer controls than the mint now uses is a changed issuer config.
  const drifted = { ...thawed, address: pubkey(), pool: { ...thawed.pool!, admitted: 6 } };
  expect(() => buildBatchPlans({ ...input, rows: [{ ...tsla, legs: [drifted] }] })).toThrow(
    "issuer configuration changed",
  );
});

test("returned evidence must match every immutable row field, source snapshot and deployment, allowing server timestamps", () => {
  const [plan, other] = plans() as [BatchPlan, BatchPlan];
  expect(() => assertBatchPacket(plan, packet(plan))).not.toThrow();
  expect(() => assertBatchPacket(plan, packet(other))).toThrow("differs");
  for (const mutate of [
    (view: EvidenceView) => {
      view.envelope.packet.preparer = pubkey();
    },
    (view: EvidenceView) => {
      view.envelope.packet.deployment.config = pubkey();
    },
    (view: EvidenceView) => {
      if (view.envelope.packet.kind === "market-creation")
        view.envelope.packet.sourceUrls = ["https://example.com/other"];
    },
    (view: EvidenceView) => {
      if (view.envelope.packet.kind === "market-creation")
        view.envelope.packet.polymarket.metadataSnapshotId = "other";
    },
    (view: EvidenceView) => {
      if (view.envelope.packet.kind === "market-creation")
        view.envelope.packet.config.maxOrderQuantity = "2";
    },
  ]) {
    const view = packet(plan);
    mutate(view);
    expect(() => assertBatchPacket(plan, view)).toThrow();
    view.envelope.packetHash = hashCanonical(view.envelope.packet);
    expect(() => assertBatchPacket(plan, view)).toThrow();
  }
});

test("preparation is sequential, once per pair, with progress and no implicit approval or transaction signing", async () => {
  const batch = plans(),
    states = pending(batch),
    calls: string[] = [],
    phases: string[] = [];
  let inFlight = 0;
  await prepareMarketBatch(batch, states, {
    check() {},
    async prepare(plan) {
      expect(inFlight++).toBe(0);
      await Promise.resolve();
      inFlight--;
      calls.push(plan.expectedMarketId);
      return packet(plan);
    },
    update(index, result) {
      states[index] = result;
      phases.push(result.phase);
    },
  });
  expect(calls).toEqual(batch.map((plan) => plan.expectedMarketId));
  expect(phases).toEqual([
    "preparing",
    "prepared",
    "preparing",
    "prepared",
    "preparing",
    "prepared",
  ]);
  await prepareMarketBatch(batch, states, {
    check() {},
    prepare: async () => {
      throw new Error("must not retry");
    },
    update() {
      throw new Error("must not update");
    },
  });
});

test("ambiguous errors halt the batch, preserve successes and only unattempted rows may continue", async () => {
  const batch = plans(),
    states = pending(batch),
    calls: string[] = [];
  const ports = {
    check() {},
    update(index: number, result: BatchResult) {
      states[index] = result;
    },
    async prepare(plan: BatchPlan) {
      calls.push(plan.expectedMarketId);
      if (plan === batch[1]) throw new Error("timeout after possible save");
      return packet(plan);
    },
  };
  await prepareMarketBatch(batch, states, ports);
  expect(states.map((row) => row.phase)).toEqual(["prepared", "uncertain", "pending"]);
  await prepareMarketBatch(batch, states, ports);
  expect(calls).toEqual(batch.map((plan) => plan.expectedMarketId));
  expect(states.map((row) => row.phase)).toEqual(["prepared", "uncertain", "prepared"]);
});

test("recovery reuses exact saved packets, ignores rejected/unrelated/tampered ones, and refuses ambiguous matches", () => {
  const batch = plans(),
    states = pending(batch),
    first = packet(batch[0]!),
    second = packet(batch[1]!);
  states[1] = { phase: "uncertain", message: "timeout" };
  const recovered = recoverBatchResults(batch, states, [first, second, packet(plans()[0]!)]);
  expect(recovered.map((row) => row.phase)).toEqual(["prepared", "prepared", "pending"]);
  expect(recoverBatchResults(batch, states, [{ ...second, status: "rejected" }])[1]!.phase).toBe(
    "uncertain",
  );
  const duplicate = packet(batch[1]!);
  duplicate.envelope.packet.preparedAt = new Date(nowMs + 6000).toISOString();
  duplicate.envelope.packetHash = hashCanonical(duplicate.envelope.packet);
  expect(recoverBatchResults(batch, states, [second, duplicate])[1]!.phase).toBe("uncertain");
  expect(recoverBatchResults(batch, recovered, [])[0]).toBe(recovered[0]);
});

test("wrong responses and session changes stop remaining writes; a stale context before starting sends nothing", async () => {
  for (const fail of ["response", "context", "before"] as const) {
    const batch = plans(),
      states = pending(batch);
    let calls = 0;
    const execute = () =>
      prepareMarketBatch(batch, states, {
        check() {
          if (fail === "before" || (fail === "context" && calls > 0))
            throw new Error("Session changed");
        },
        async prepare(plan) {
          calls++;
          return packet(fail === "response" ? batch[1]! : plan);
        },
        update(index, result) {
          states[index] = result;
        },
      });
    if (fail === "before") {
      await expect(execute()).rejects.toThrow("Session changed");
      expect(calls).toBe(0);
    } else {
      await execute();
      expect(calls).toBe(1);
      expect(states.map((row) => row.phase)).toEqual(["uncertain", "pending", "pending"]);
    }
  }
});

const quoteKey = new PublicKey(quote.address);
/** Mocked RPC keyed by account address (mints, pools, pool vaults). */
const mintClient = (accounts: Record<string, AccountInfo<Buffer> | null> = {}) => {
  const client = new SolanaClient(deployment),
    calls: string[] = [];
  client.assertNetwork = async () => {
    calls.push("network");
  };
  client.configAccount = async () => {
    calls.push("config");
    return {
      quote_mint: quoteKey,
      roles: {
        market_admin: new PublicKey(deployment.marketAdmin),
        resolution_admin: new PublicKey(deployment.resolutionAdmin),
      },
    } as Awaited<ReturnType<SolanaClient["configAccount"]>>;
  };
  client.connection.getMultipleAccountsInfo = async (keys) => {
    calls.push("accounts:" + keys.length);
    return keys.map((k) => (k.equals(quoteKey) ? splMint(6) : (accounts[k.toBase58()] ?? null)));
  };
  return { client, calls };
};
const poolOf = (mint: string) => poolAddress(key(deployment.config), key(mint), PROGRAM_ID);
const vaultOf = (mint: string) => poolVaultAddress(poolOf(mint), PROGRAM_ID);
const nvdaAccounts = () => ({
  [NVDAX]: mintFixture(NVDAX),
  [NVDAON]: mintFixture(NVDAON),
  [NVDAR]: mintFixture(NVDAR),
});

test("live lookup verifies network, derives quote and roles, and decodes each real issuer's controls, decimals, symbol and multiplier", async () => {
  const { client, calls } = mintClient(nvdaAccounts());
  const result = await loadBatchMints(client, [[NVDAX, NVDAON, NVDAR]], FIXTURE_NOW_MS);
  expect(calls).toEqual(["network", "config", "accounts:1", "accounts:9"]);
  expect(result.quote).toMatchObject({
    address: quote.address,
    decimals: 6,
    standard: "SPL Token",
  });
  expect(result.deployment.marketAdmin).toBe(deployment.marketAdmin);
  const mints = [NVDAX, NVDAON, NVDAR].map((address) => {
    const check = result.checks[address]!;
    if (!check.ok) throw new Error(check.error);
    return check.mint;
  });
  expect(mints.map((m) => m.symbol)).toEqual(["NVDAx", "NVDAon", "NVDAr"]);
  expect(mints.map((m) => m.decimals)).toEqual([8, 9, 9]);
  expect(mints.map((m) => m.issuer.controls)).toEqual([63, 62, 47]);
  expect(mints[0]!.issuer.controlNames).toEqual([
    "permanentDelegate",
    "pausable",
    "defaultAccountState",
    "scaledUiAmount",
    "transferHook",
    "confidentialTransfer",
  ]);
  expect(mints[1]!.issuer.controlNames).not.toContain("permanentDelegate");
  expect(mints[2]!.issuer.controlNames).not.toContain("transferHook");
  expect(mints.map((m) => m.issuer.multiplierValue)).toEqual([
    1.001701196801074, 1.0017152487959897, 1,
  ]);
  expect(mints.every((m) => !m.issuer.paused && !m.issuer.defaultFrozen)).toBe(true);
  expect(mints.every((m) => m.standard === "Token-2022" && m.pool?.admitted === null)).toBe(true);
  // The real NVDA trio forms one valid market with default share decimals 6.
  const { rows, problems } = resolveRows(result, [
    { mints: [NVDAX, NVDAON, NVDAR], shareDecimals: "6", caps: defaultMarketCaps(6, 6) },
  ]);
  expect(problems).toEqual([[]]);
  expect(rows[0]!.legs.map((leg) => leg.address)).toEqual([NVDAX, NVDAON, NVDAR]);
  expect(() =>
    buildBatchPlans({ ...makeInput(), quote: result.quote, rows, deployment: result.deployment }),
  ).not.toThrow();
  expect(
    resolveRows(result, [
      { mints: [NVDAX, NVDAON, NVDAR], shareDecimals: "9", caps: defaultMarketCaps(9, 6) },
    ]).problems[0]!.join(" "),
  ).toContain("NVDAx (Xsc9…9qEh) has 8 decimals, fewer than the market's 9 share decimals");
});

test("paused, hook-enabled, default-frozen, missing, foreign and quote tokens are rejected per market with explanations", async () => {
  const pausedMint = pubkey(),
    hookMint = pubkey(),
    frozenMint = pubkey(),
    thawedMint = pubkey(),
    foreign = pubkey(),
    missing = pubkey();
  const { client } = mintClient({
    ...nvdaAccounts(),
    [pausedMint]: paused(mintFixture(NVDAX)),
    [hookMint]: hookSet(mintFixture(NVDAX)),
    [frozenMint]: defaultFrozen(mintFixture(NVDAR)),
    [thawedMint]: defaultFrozen(mintFixture(NVDAR)),
    [vaultOf(thawedMint).toBase58()]: tokenAccount(1, TOKEN_2022_PROGRAM_ID),
    [poolOf(thawedMint).toBase58()]: {
      data: encodeAccount("AssetPool", {
        config: key(deployment.config),
        mint: key(thawedMint),
        token_program: TOKEN_2022_PROGRAM_ID,
        liability: bn(0),
        decimals: 9,
        bump: 255,
        admitted: 47,
        vault_bump: 255,
      }),
      owner: PROGRAM_ID,
      executable: false,
      lamports: 1,
      rentEpoch: 0,
    },
    [foreign]: splMint(6, PublicKey.unique()),
  });
  const rows = [
    [NVDAX, pausedMint],
    [hookMint],
    [frozenMint],
    [thawedMint],
    [foreign],
    [missing],
    [quote.address],
  ];
  const result = await loadBatchMints(client, rows, FIXTURE_NOW_MS);
  const thawed = result.checks[thawedMint]!;
  expect(thawed.ok && thawed.mint.pool).toEqual({
    admitted: 47,
    vault: vaultOf(thawedMint).toBase58(),
    vaultFrozen: false,
  });
  const { problems } = resolveRows(
    result,
    rows.map((mints) => ({ mints, shareDecimals: "6", caps: defaultMarketCaps(6, 6) })),
  );
  const text = problems.map((list) => list.join(" "));
  expect(problems[0]).toHaveLength(1);
  expect(text[0]).toContain("paused by its issuer");
  expect(text[1]).toContain("transfer hook is configured");
  expect(text[2]).toContain("allowlist and thaw that vault");
  expect(text[2]).toContain(vaultOf(frozenMint).toBase58());
  expect(problems[3]).toEqual([]);
  expect(text[4]).toContain(foreign);
  expect(text[5]).toContain("Mint is missing");
  expect(text[6]).toContain("configured quote token");
});

test("network errors fail closed before reads; identity ignores live multipliers but not decimals or issuer controls", async () => {
  const wrongNetwork = mintClient();
  wrongNetwork.client.assertNetwork = async () => {
    throw new Error("Wrong genesis");
  };
  await expect(loadBatchMints(wrongNetwork.client, [[pubkey()]])).rejects.toThrow("genesis");
  expect(wrongNetwork.calls).toEqual([]);
  const { client } = mintClient(nvdaAccounts());
  const before = await loadBatchMints(client, [[NVDAX]], FIXTURE_NOW_MS - 10_000_000_000),
    after = await loadBatchMints(client, [[NVDAX]], FIXTURE_NOW_MS);
  const multiplier = (value: typeof before) => {
    const check = value.checks[NVDAX]!;
    return check.ok ? check.mint.issuer.multiplierValue : 0;
  };
  expect(multiplier(before)).not.toBe(multiplier(after));
  expect(mintIdentity(before)).toBe(mintIdentity(after));
  const changed = mintClient({ [NVDAX]: mintFixture(NVDAR) });
  expect(mintIdentity(await loadBatchMints(changed.client, [[NVDAX]], FIXTURE_NOW_MS))).not.toBe(
    mintIdentity(after),
  );
});
