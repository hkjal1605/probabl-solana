import { expect, test } from "bun:test";
import { hashCanonical, normalizeGammaMarket } from "@conditional-stocks/market-data";
import {
  big,
  coder,
  PROGRAM_ID,
  PublicKey,
  SolanaClient,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unwrap,
} from "@conditional-stocks/solana-client";
import { evidenceTransaction } from "@conditional-stocks/solana-client/admin";
import { buildCreationEvidence } from "@conditional-stocks/solana-client/evidence";
import { gammaMarket } from "../../../packages/market-data/tests/helpers";
import type { EvidenceView } from "../src/lib/admin-api";
import { dateTimeInputToUnixSeconds } from "../src/lib/date-time";
import {
  assertBatchPacket,
  type BatchPlan,
  type BatchResult,
  buildBatchPlans,
  defaultMarketCaps,
  loadBatchMints,
  MAX_BATCH_MARKETS,
  type MarketCaps,
  parseBaseMints,
  prepareMarketBatch,
  recoverBatchResults,
  validateMarketCaps,
} from "../src/lib/market-batch";

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
const quote = { address: pubkey(), decimals: 6, standard: "SPL Token" };
const nowMs = Date.parse("2026-09-13T00:00:00Z");
const shared = {
  tradingOpen: String(nowMs / 1000),
  tradingCutoff: "1798761600",
  metadataUri: source.normalized.canonicalUrl,
  sourceUrls: source.normalized.canonicalUrl,
};
const makeInput = () => ({
  deployment,
  owner: deployment.marketAdmin,
  source,
  quote,
  shared,
  nowMs,
  rows: [6, 8, 9].map((decimals) => ({
    mint: { address: pubkey(), decimals, standard: decimals === 6 ? "Token-2022" : "SPL Token" },
    caps: defaultMarketCaps(decimals, 6),
  })),
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

test("base list accepts newlines/commas and 1–20 unique mints; rejects duplicates, empty, symbols, wallet URLs and overflow", () => {
  const keys = Array.from({ length: MAX_BATCH_MARKETS }, pubkey);
  expect(parseBaseMints(`  ${keys[0]},\n${keys[1]} \t`)).toEqual(keys.slice(0, 2));
  expect(parseBaseMints(keys.join("\n"))).toEqual(keys);
  for (const input of [
    "",
    " \n,",
    "TSLA",
    "https://example.com/mint",
    keys[0] + "," + keys[0],
    [...keys, pubkey()].join(" "),
  ])
    expect(() => parseBaseMints(input)).toThrow();
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

test("a shared source builds different deterministic market PDAs and exact native instructions for every base", () => {
  const input = makeInput(),
    batch = buildBatchPlans(input);
  expect(new Set(batch.map((plan) => plan.expectedMarketId)).size).toBe(3);
  expect(
    buildBatchPlans({ ...input, nowMs: nowMs + 1000 }).map((plan) => plan.expectedMarketId),
  ).toEqual(batch.map((plan) => plan.expectedMarketId));
  batch.forEach((plan, index) => {
    expect(plan.body.metadataSnapshotId).toBe(source.snapshotId);
    expect(plan.envelope.packet.config.polymarketConditionId).toBe(source.normalized.conditionId);
    expect(plan.envelope.packet.config.quoteToken).toBe(quote.address);
    const instruction = coder.instruction.decode(
      unwrap(evidenceTransaction(plan.envelope, "create-market", deployment))[0]!.data,
    )!;
    expect(instruction.name).toBe("create_market");
    expect(big((instruction.data as any).terms.step)).toBe(
      BigInt(input.rows[index]!.caps.baseStep),
    );
  });
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

test("invalid rows, role, identical base/quote, timestamps, missing source URLs and excessive URI length fail before writes", () => {
  const input = makeInput();
  for (const change of [
    { rows: [] },
    { rows: [input.rows[0]!, input.rows[0]!] },
    { owner: pubkey() },
    { rows: [{ ...input.rows[0]!, mint: quote }] },
    { shared: { ...shared, tradingCutoff: shared.tradingOpen } },
    { shared: { ...shared, tradingCutoff: String(nowMs / 1000 - 1) } },
    { shared: { ...shared, tradingCutoff: "999999999999999999999" } },
    { shared: { ...shared, tradingOpen: "-1" } },
    { shared: { ...shared, sourceUrls: "" } },
    { shared: { ...shared, metadataUri: "https://example.com/" + "x".repeat(512) } },
    {
      rows: [
        input.rows[0]!,
        { ...input.rows[1]!, caps: { ...input.rows[1]!.caps, minNotional: "0" } },
      ],
    },
  ])
    expect(() => buildBatchPlans({ ...input, ...change })).toThrow();
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

const mintAccount = (decimals: number, owner = TOKEN_PROGRAM_ID) => {
  const data = Buffer.alloc(82);
  data[44] = decimals;
  data[45] = 1;
  return { data, owner, executable: false, lamports: 1, rentEpoch: 0 };
};
const mintClient = () => {
  const client = new SolanaClient(deployment),
    calls: string[] = [],
    quoteMint = new PublicKey(quote.address);
  client.assertNetwork = async () => {
    calls.push("network");
  };
  client.configAccount = async () => {
    calls.push("config");
    return {
      quote_mint: quoteMint,
      roles: {
        market_admin: new PublicKey(deployment.marketAdmin),
        resolution_admin: new PublicKey(deployment.resolutionAdmin),
      },
    } as Awaited<ReturnType<SolanaClient["configAccount"]>>;
  };
  client.connection.getMultipleAccountsInfo = async (keys) => {
    calls.push("mints");
    expect(keys[0]!.equals(quoteMint)).toBe(true);
    return keys.map((_, i) =>
      mintAccount(i === 0 ? 6 : 9, i === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID),
    );
  };
  return { client, calls };
};

test("live mint lookup verifies network, derives the fixed quote and roles from config, and decodes both token standards", async () => {
  const { client, calls } = mintClient(),
    base = pubkey();
  const result = await loadBatchMints(client, [base]);
  expect(calls).toEqual(["network", "config", "mints"]);
  expect(result.quote).toEqual(quote);
  expect(result.bases).toEqual([{ address: base, decimals: 9, standard: "Token-2022" }]);
  expect(result.deployment.marketAdmin).toBe(deployment.marketAdmin);
  await expect(loadBatchMints(client, [quote.address])).rejects.toThrow("quote token");
});

test("network, missing mint, foreign owner and unsupported Token-2022 extension errors fail closed", async () => {
  const wrongNetwork = mintClient();
  wrongNetwork.client.assertNetwork = async () => {
    throw new Error("Wrong genesis");
  };
  await expect(loadBatchMints(wrongNetwork.client, [pubkey()])).rejects.toThrow("genesis");
  expect(wrongNetwork.calls).toEqual([]);
  const extended = mintAccount(6, TOKEN_2022_PROGRAM_ID),
    extensionData = Buffer.alloc(170);
  extended.data.copy(extensionData);
  extensionData[165] = 1;
  extensionData.writeUInt16LE(14, 166); // TransferHook, not supported by the deployed policy.
  for (const invalid of [
    null,
    mintAccount(6, PublicKey.unique()),
    { ...extended, data: extensionData },
    { ...extended, data: Buffer.alloc(82) },
  ]) {
    const { client } = mintClient();
    client.connection.getMultipleAccountsInfo = async () => [mintAccount(6), invalid];
    await expect(loadBatchMints(client, [pubkey()])).rejects.toThrow();
  }
});
