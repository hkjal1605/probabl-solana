import {
  canonicalStringify,
  type NormalizedPolymarketMarket,
} from "@conditional-stocks/market-data";
import {
  key,
  MAX_BASES,
  marketAddress,
  type SolanaClient,
} from "@conditional-stocks/solana-client";
import {
  type AdminDeployment,
  evidenceTransaction,
  marketIdFromConfig,
} from "@conditional-stocks/solana-client/admin";
import {
  assertEvidenceIntegrity,
  buildCreationEvidence,
} from "@conditional-stocks/solana-client/evidence";
import type { EvidenceView } from "./admin-api";
import {
  assetLegProblems,
  checkIssuerMints,
  inspectMint,
  type MintCheck,
  type MintInfo,
  parseShareDecimals,
} from "./issuer-mints";

export type { MintInfo } from "./issuer-mints";
/** Asset markets per batch (e.g. NVDA and TSLA of one Polymarket event), each with 1-3 issuer legs. */
export const MAX_BATCH_MARKETS = 20;
const U64 = (1n << 64n) - 1n,
  U128 = (1n << 128n) - 1n,
  WAD = 10n ** 18n;
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b;
/** Quantities (step, max quantity) are share units; notionals are quote raw units. */
export interface MarketCaps {
  baseStep: string;
  priceTickRawX18: string;
  minNotional: string;
  maxOrderQuantity: string;
  maxOrderNotional: string;
  maxWalletOpenNotional: string;
  maxMarketOpenNotional: string;
}
/** One market for one asset: its ordered issuer-token legs and share precision. */
export interface MarketRow {
  legs: MintInfo[];
  shareDecimals: number;
  caps: MarketCaps;
}
export interface MarketSource {
  normalized: NormalizedPolymarketMarket;
  rawHash: `0x${string}`;
  snapshotId: string;
}
export interface SharedMarketFields {
  tradingOpen: string;
  tradingCutoff: string;
  metadataUri: string;
  sourceUrls: string;
}
export type CreationConfigBody = Record<string, string | string[]>;
export interface BatchPlan {
  legs: MintInfo[];
  baseTokens: string[];
  shareDecimals: number;
  quote: MintInfo;
  /** Market PDA of `marketIdFromConfig(config)`. */
  expectedMarketId: string;
  envelope: ReturnType<typeof buildCreationEvidence>;
  body: {
    attachments: never[];
    config: CreationConfigBody;
    metadataSnapshotId: string;
    sourceUrls: string[];
  };
}
export type BatchResult =
  | { phase: "pending" }
  | { phase: "preparing" }
  | { phase: "uncertain"; message: string }
  | { phase: "prepared"; packet: EvidenceView };

/** One market's issuer mints, in leg order: 1-3 distinct addresses. */
export function parseIssuerMints(input: string): string[] {
  const addresses = input
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((value) => key(value).toBase58());
  if (!addresses.length || addresses.length > MAX_BASES)
    throw new Error(`Enter 1 to ${MAX_BASES} issuer token mints of the same asset per market.`);
  if (new Set(addresses).size !== addresses.length)
    throw new Error("Duplicate issuer token in one market.");
  return addresses;
}

/** Every market row's issuer mints; an issuer token may belong to only one market of the batch. */
export function parseAssetRows(inputs: string[]): string[][] {
  if (!inputs.length || inputs.length > MAX_BATCH_MARKETS)
    throw new Error(`Enter between 1 and ${MAX_BATCH_MARKETS} asset markets.`);
  const rows = inputs.map((input, index) => {
    try {
      return parseIssuerMints(input);
    } catch (error) {
      throw new Error(
        `Market ${index + 1}: ${error instanceof Error ? error.message : "invalid mints"}`,
      );
    }
  });
  const all = rows.flat();
  if (new Set(all).size !== all.length)
    throw new Error("An issuer token appears in more than one market of this batch.");
  return rows;
}

export async function loadBatchMints(client: SolanaClient, rows: string[][], nowMs = Date.now()) {
  const flat = parseAssetRows(rows.map((row) => row.join("\n"))).flat();
  await client.assertNetwork();
  const config = await client.configAccount();
  const quoteAddress = config.quote_mint.toBase58();
  const [quoteInfo] = await client.connection.getMultipleAccountsInfo(
    [config.quote_mint],
    "confirmed",
  );
  const quote = inspectMint(quoteAddress, quoteInfo ?? null, BigInt(Math.floor(nowMs / 1000)));
  const checks: Record<string, MintCheck> = await checkIssuerMints(client, flat, nowMs);
  return {
    quote,
    checks,
    deployment: {
      ...client.deployment,
      programId: client.program.toBase58(),
      marketAdmin: config.roles.market_admin.toBase58(),
      resolutionAdmin: config.roles.resolution_admin.toBase58(),
    } satisfies AdminDeployment,
  };
}
export type VerifiedMints = Awaited<ReturnType<typeof loadBatchMints>>;

/** Immutable facts a reviewed row depends on; live multipliers and pause state are re-validated instead. */
export function mintIdentity(verified: VerifiedMints) {
  const mint = (m: MintInfo) => ({
    address: m.address,
    decimals: m.decimals,
    standard: m.standard,
    controls: m.issuer.controls,
    pool: m.pool?.admitted ?? null,
  });
  return canonicalStringify({
    deployment: verified.deployment,
    quote: mint(verified.quote),
    mints: Object.values(verified.checks).map((check) =>
      check.ok ? mint(check.mint) : { address: check.address, error: true },
    ),
  });
}

/** Rows ready for planning (every leg verified), or the problems per market. */
export function resolveRows(
  verified: VerifiedMints,
  rows: { mints: string[]; shareDecimals: string; caps: MarketCaps }[],
): { rows: MarketRow[]; problems: string[][] } {
  const problems: string[][] = [],
    ready: MarketRow[] = [];
  for (const row of rows) {
    const checks = row.mints.map(
      (address): MintCheck =>
        verified.checks[address] ?? {
          ok: false,
          address,
          error: "Token not verified. Load the tokens again.",
        },
    );
    let shareDecimals = 0;
    const issues: string[] = [];
    try {
      shareDecimals = parseShareDecimals(row.shareDecimals);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : "Invalid share decimals");
    }
    if (!issues.length)
      issues.push(...assetLegProblems(checks, verified.quote.address, shareDecimals));
    try {
      validateMarketCaps(row.caps);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : "Invalid caps");
    }
    problems.push(issues);
    if (!issues.length)
      ready.push({
        legs: checks.map((check) => (check as { ok: true; mint: MintInfo }).mint),
        shareDecimals,
        caps: row.caps,
      });
  }
  return { rows: problems.some((list) => list.length) ? [] : ready, problems };
}

/** Human defaults in share units: step .001 share, max 1000 shares, tick .01 quote/share.
 * Clamp to integer domains for unusual precision; every row is reviewed. */
export function defaultMarketCaps(shareDecimals: number, quoteDecimals: number): MarketCaps {
  for (const d of [shareDecimals, quoteDecimals])
    if (!Number.isInteger(d) || d < 0 || d > 255) throw new Error("Invalid mint decimals");
  const base = 10n ** BigInt(shareDecimals),
    quote = 10n ** BigInt(quoteDecimals);
  const step = min(base >= 1000n ? base / 1000n : 1n, U64);
  const humanTick = min(ceil(WAD * quote, 100n * base), U128);
  const tick = humanTick > ceil(WAD, step) ? humanTick : ceil(WAD, step);
  return {
    baseStep: String(step),
    priceTickRawX18: String(tick),
    maxOrderQuantity: String((min(1000n * base, U64) / step) * step),
    minNotional: String(min(quote, U64 / 4n)),
    maxOrderNotional: String(min(10000n * quote, U64)),
    maxWalletOpenNotional: String(min(100000n * quote, U64)),
    maxMarketOpenNotional: String(min(1000000n * quote, U64)),
  };
}

/** Mirrors protocol-core Caps::validate using exact integers, before any API write. */
export function validateMarketCaps(caps: MarketCaps) {
  const values = Object.fromEntries(
    Object.entries(caps).map(([name, value]) => {
      if (!/^[1-9][0-9]*$/.test(value) || value.length > 39)
        throw new Error(`${name} must be a positive raw integer`);
      const n = BigInt(value);
      if (n > (name === "priceTickRawX18" ? U128 : U64))
        throw new Error(`${name} exceeds the contract's integer range`);
      return [name, n];
    }),
  ) as Record<keyof MarketCaps, bigint>;
  const c = values;
  if (
    c.maxOrderQuantity < c.baseStep ||
    c.maxOrderNotional < c.minNotional ||
    c.maxWalletOpenNotional < c.maxOrderNotional ||
    c.maxMarketOpenNotional < c.maxWalletOpenNotional
  )
    throw new Error(
      "Caps must satisfy step ≤ quantity and minimum ≤ order ≤ wallet ≤ market notional.",
    );
  const product = c.baseStep * c.priceTickRawX18;
  if (product / WAD === 0n || product / WAD > U64)
    throw new Error("The step/tick combination must produce a nonzero u64 quote amount.");
  const minimumPrice = (((c.minNotional - 1n) * WAD) / product + 1n) * c.priceTickRawX18;
  const notional = ceil(c.baseStep * minimumPrice, WAD);
  if (
    minimumPrice > U128 ||
    notional > c.maxOrderNotional ||
    notional * 2n > c.maxMarketOpenNotional
  )
    throw new Error("The step/tick/minimum combination cannot fit inside the market caps.");
}

export function buildBatchPlans(input: {
  rows: MarketRow[];
  quote: MintInfo;
  source: MarketSource;
  shared: SharedMarketFields;
  deployment: AdminDeployment;
  owner: string;
  nowMs?: number;
}): BatchPlan[] {
  const { rows, quote, source, shared, deployment, owner } = input;
  const nowMs = input.nowMs ?? Date.now();
  parseAssetRows(rows.map((row) => row.legs.map((leg) => leg.address).join("\n")));
  if (owner !== deployment.marketAdmin)
    throw new Error("Connect the configured market-admin wallet to prepare this batch.");
  if (
    !/^[1-9][0-9]*$/.test(shared.tradingCutoff) ||
    BigInt(shared.tradingCutoff) <= BigInt(Math.floor(nowMs / 1000))
  )
    throw new Error("Trading cutoff must still be in the future.");
  return rows.map((row, index) => {
    const shareDecimals = parseShareDecimals(row.shareDecimals);
    const problems = assetLegProblems(
      row.legs.map((mint) => ({ ok: true, mint })),
      quote.address,
      shareDecimals,
    );
    if (problems.length) throw new Error(`Market ${index + 1}: ${problems[0]}`);
    validateMarketCaps(row.caps);
    const baseTokens = row.legs.map((leg) => leg.address);
    const config = {
      ...row.caps,
      baseTokens,
      shareDecimals: String(shareDecimals),
      quoteToken: quote.address,
      tradingOpen: shared.tradingOpen,
      tradingCutoff: shared.tradingCutoff,
      metadataUri: shared.metadataUri,
      rules: source.normalized.rules,
    };
    const envelope = buildCreationEvidence({
      deployment,
      preparer: owner,
      preparedAt: new Date(nowMs).toISOString(),
      attachments: [],
      config,
      metadata: source.normalized,
      metadataRawHash: source.rawHash,
      metadataSnapshotId: source.snapshotId,
      sourceUrls: shared.sourceUrls
        .split("\n")
        .map((v) => v.trim())
        .filter(Boolean),
    });
    const expectedMarketId = marketAddress(
      key(deployment.config),
      marketIdFromConfig(envelope.packet.config),
      key(deployment.programId),
    ).toBase58();
    if (
      evidenceTransaction(envelope, "create-market", deployment).expectedMarketId !==
      expectedMarketId
    )
      throw new Error("Market identity differs from the create-market transaction.");
    return {
      legs: row.legs,
      baseTokens,
      shareDecimals,
      quote,
      envelope,
      expectedMarketId,
      body: {
        attachments: [],
        config,
        metadataSnapshotId: source.snapshotId,
        sourceUrls: envelope.packet.sourceUrls,
      },
    };
  });
}

export function assertBatchPacket(plan: BatchPlan, packet: EvidenceView) {
  assertEvidenceIntegrity(packet.envelope);
  const actual = packet.envelope.packet,
    expected = plan.envelope.packet;
  if (
    actual.kind !== "market-creation" ||
    canonicalStringify(actual.config) !== canonicalStringify(expected.config) ||
    canonicalStringify(actual.deployment) !== canonicalStringify(expected.deployment) ||
    canonicalStringify(actual.polymarket) !== canonicalStringify(expected.polymarket) ||
    canonicalStringify(actual.sourceUrls) !== canonicalStringify(expected.sourceUrls) ||
    canonicalStringify(actual.attachments) !== canonicalStringify(expected.attachments) ||
    actual.preparer !== expected.preparer
  )
    throw new Error("The returned evidence differs from this reviewed batch row.");
}

export function recoverBatchResults(
  plans: BatchPlan[],
  results: BatchResult[],
  packets: EvidenceView[],
) {
  return plans.map((plan, index): BatchResult => {
    if (results[index]?.phase === "prepared") return results[index];
    const matches = packets.filter((packet) => {
      try {
        assertBatchPacket(plan, packet);
        return packet.status !== "rejected";
      } catch {
        return false;
      }
    });
    if (matches.length > 1)
      return {
        phase: "uncertain",
        message:
          "Multiple matching packets exist. Resolve them in the review queue before proceeding.",
      };
    return matches[0]
      ? { phase: "prepared", packet: matches[0] }
      : (results[index] ?? { phase: "pending" });
  });
}

/** Only send unattempted rows. Never retry ambiguous requests automatically. */
export async function prepareMarketBatch(
  plans: BatchPlan[],
  results: BatchResult[],
  ports: {
    check(): void;
    prepare(plan: BatchPlan): Promise<EvidenceView>;
    update(index: number, result: BatchResult): void;
  },
) {
  for (const [index, plan] of plans.entries()) {
    if (results[index]?.phase !== "pending") continue;
    ports.check();
    ports.update(index, { phase: "preparing" });
    try {
      const packet = await ports.prepare(plan);
      ports.check();
      assertBatchPacket(plan, packet);
      ports.update(index, { phase: "prepared", packet });
    } catch (error) {
      ports.update(index, {
        phase: "uncertain",
        message: error instanceof Error ? error.message : "Request outcome unknown",
      });
      return;
    }
  }
}
