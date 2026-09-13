import {
  canonicalStringify,
  type NormalizedPolymarketMarket,
} from "@conditional-stocks/market-data";
import {
  decodeSupportedMint,
  key,
  type SolanaClient,
  TOKEN_PROGRAM_ID,
} from "@conditional-stocks/solana-client";
import { type AdminDeployment, evidenceTransaction } from "@conditional-stocks/solana-client/admin";
import {
  assertEvidenceIntegrity,
  buildCreationEvidence,
} from "@conditional-stocks/solana-client/evidence";
import type { EvidenceView } from "./admin-api";

export const MAX_BATCH_MARKETS = 20;
const U64 = (1n << 64n) - 1n,
  U128 = (1n << 128n) - 1n,
  WAD = 10n ** 18n;
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b;
export interface MintInfo {
  address: string;
  decimals: number;
  standard: string;
}
export interface MarketCaps {
  baseStep: string;
  priceTickRawX18: string;
  minNotional: string;
  maxOrderQuantity: string;
  maxOrderNotional: string;
  maxWalletOpenNotional: string;
  maxMarketOpenNotional: string;
}
export interface MarketRow {
  mint: MintInfo;
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
export interface BatchPlan {
  base: MintInfo;
  quote: MintInfo;
  expectedMarketId: string;
  envelope: ReturnType<typeof buildCreationEvidence>;
  body: {
    attachments: never[];
    config: Record<string, string>;
    metadataSnapshotId: string;
    sourceUrls: string[];
  };
}
export type BatchResult =
  | { phase: "pending" }
  | { phase: "preparing" }
  | { phase: "uncertain"; message: string }
  | { phase: "prepared"; packet: EvidenceView };

export function parseBaseMints(input: string): string[] {
  const addresses = input
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((value) => key(value).toBase58());
  if (!addresses.length || addresses.length > MAX_BATCH_MARKETS)
    throw new Error(`Enter between 1 and ${MAX_BATCH_MARKETS} base mint addresses.`);
  if (new Set(addresses).size !== addresses.length)
    throw new Error("Duplicate base mint in this batch.");
  return addresses;
}

export async function loadBatchMints(client: SolanaClient, addresses: string[]) {
  const bases = parseBaseMints(addresses.join("\n"));
  await client.assertNetwork();
  const config = await client.configAccount();
  const quoteAddress = config.quote_mint.toBase58();
  if (bases.includes(quoteAddress))
    throw new Error("A base token cannot also be the configured quote token.");
  const all = [quoteAddress, ...bases];
  const accounts = await client.connection.getMultipleAccountsInfo(all.map(key), "confirmed");
  const mints = all.map((address, index): MintInfo => {
    const mint = decodeSupportedMint(key(address), accounts[index] ?? null);
    return {
      address,
      decimals: mint.decimals,
      standard: mint.program.equals(TOKEN_PROGRAM_ID) ? "SPL Token" : "Token-2022",
    };
  });
  return {
    quote: mints[0]!,
    bases: mints.slice(1),
    deployment: {
      ...client.deployment,
      programId: client.program.toBase58(),
      marketAdmin: config.roles.market_admin.toBase58(),
      resolutionAdmin: config.roles.resolution_admin.toBase58(),
    } satisfies AdminDeployment,
  };
}

/** Human defaults: step .001 base, max 1000 base, tick .01 quote/base.
 * Clamp to integer domains for unusual mint precision; every row is reviewed. */
export function defaultMarketCaps(baseDecimals: number, quoteDecimals: number): MarketCaps {
  for (const d of [baseDecimals, quoteDecimals])
    if (!Number.isInteger(d) || d < 0 || d > 255) throw new Error("Invalid mint decimals");
  const base = 10n ** BigInt(baseDecimals),
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
  parseBaseMints(rows.map((row) => row.mint.address).join("\n"));
  if (owner !== deployment.marketAdmin)
    throw new Error("Connect the configured market-admin wallet to prepare this batch.");
  if (
    !/^[1-9][0-9]*$/.test(shared.tradingCutoff) ||
    BigInt(shared.tradingCutoff) <= BigInt(Math.floor(nowMs / 1000))
  )
    throw new Error("Trading cutoff must still be in the future.");
  return rows.map((row) => {
    if (row.mint.address === quote.address) throw new Error("Base and quote mints must differ.");
    validateMarketCaps(row.caps);
    const config = {
      ...row.caps,
      baseToken: row.mint.address,
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
    const expected = evidenceTransaction(envelope, "create-market", deployment);
    return {
      base: row.mint,
      quote,
      envelope,
      expectedMarketId: expected.expectedMarketId,
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
