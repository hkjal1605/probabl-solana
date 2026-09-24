import { address, MAX_BASES, U64_MAX, unsigned } from "@conditional-stocks/solana-client";

export const BPS = 10_000n;
export const PROB = 1_000_000n;
export const min = (...values: bigint[]) => values.reduce((a, b) => (a < b ? a : b));
export const max = (...values: bigint[]) => values.reduce((a, b) => (a > b ? a : b));
export const abs = (value: bigint) => (value < 0n ? -value : value);
export const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;

/** Exact decimal conversion, including scientific notation returned by JSON price feeds. */
export function decimal(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || value.length > 80)
    throw new Error("Invalid decimal precision");
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:e([+-]?[0-9]{1,3}))?$/i.exec(value);
  if (!match) throw new Error("Invalid positive decimal");
  const fraction = match[2] ?? "",
    shift = decimals + Number(match[3] ?? 0) - fraction.length;
  if (Math.abs(shift) > 100) throw new Error("Decimal out of range");
  const digits = BigInt(match[1]! + fraction);
  return shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);
}
export function units(value: string, decimals: number) {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value) || (value.split(".")[1]?.length ?? 0) > decimals)
    throw new Error("Token allocation must use exact token decimals");
  const amount = decimal(value, decimals);
  if (amount <= 0n || amount > U64_MAX) throw new Error("Token allocation exceeds u64");
  return amount;
}
/** Seed amounts may be zero (e.g. a quote-only maker); otherwise exact token units. */
export function seedUnits(value: string, decimals: number) {
  return /^0(\.0+)?$/.test(value) ? 0n : units(value, decimals);
}
/** Legs that price the market: `referenceMints`, or every leg by default. */
export const referenceMints = (p: MarketPolicy) => p.referenceMints ?? p.baseMints;
export interface MarketPolicy {
  market: string;
  /** Whitelisted issuer tokens of the market, in on-chain leg order
   * (collateral 1..=bases). Must equal the market's listed legs exactly. */
  baseMints: string[];
  /** Legs whose Jupiter price feeds the spot (a subset of `baseMints`; default all).
   * Illiquid issuer tokens can price several percent apart: reference the most
   * liquid issuer. Other legs never affect the price or pause quoting. */
  referenceMints?: string[];
  quoteMint: string;
  /** One-time seed per leg in whole issuer tokens (raw / 10^decimals, before any
   * ScaledUiAmount multiplier). "0" seeds nothing for that leg. */
  baseInventories: string[];
  /** Reference branch position across every leg, in economic shares. Bids stop at
   * twice this. Defaults to the seeded legs at their live multipliers. */
  targetShares?: string;
  quoteInventory: string;
  orderQuote: string;
  gapBps: number;
  /** Explicit raw-token unit review per leg: reference-price unit to one raw token
   * divided by 10^decimals. The live ScaledUiAmount multiplier is applied separately. */
  basePriceMultipliers: string[];
  quotePriceMultiplier: string;
}
export interface Settings {
  markets: MarketPolicy[];
  allowStaleDevnetSpot: boolean;
  quoteLevels: number;
  levelSpacingBps: number;
  halfSpreadBps: number;
  adverseSelectionBps: number;
  maxHalfSpreadBps: number;
  repriceBps: number;
  ttlSeconds: number;
  pollMs: number;
  cutoffBufferSeconds: number;
  maxFeedAgeMs: number;
  maxProbabilitySpreadX6: number;
  probabilityFloorX6: number;
  jumpBps: number;
  probabilityJumpX6: number;
  cooldownMs: number;
  maxDrawdownBps: number;
  maxTransferFeeBps: number;
  /** Maximum disagreement between issuer legs' per-share reference prices. */
  maxLegDispersionBps: number;
  minSolLamports: string;
  dailySolBudgetLamports: string;
}
export function settings(input: unknown): Settings {
  const raw = input as Partial<Settings>;
  if (!raw || !Array.isArray(raw.markets) || raw.markets.length > 50)
    throw new Error("Configure at most 50 explicitly budgeted markets");
  const result: Settings = {
    allowStaleDevnetSpot: false,
    quoteLevels: 1,
    levelSpacingBps: 25,
    halfSpreadBps: 60,
    adverseSelectionBps: 25,
    maxHalfSpreadBps: 1500,
    repriceBps: 20,
    ttlSeconds: 120,
    pollMs: 15000,
    cutoffBufferSeconds: 300,
    maxFeedAgeMs: 30000,
    maxProbabilitySpreadX6: 50000,
    probabilityFloorX6: 20000,
    jumpBps: 500,
    probabilityJumpX6: 100000,
    cooldownMs: 60000,
    maxDrawdownBps: 1000,
    maxTransferFeeBps: 100,
    maxLegDispersionBps: 300,
    minSolLamports: "100000000",
    dailySolBudgetLamports: "100000000",
    ...raw,
    markets: raw.markets,
  };
  const ranges: Record<string, [number, number]> = {
    quoteLevels: [1, 10],
    levelSpacingBps: [1, 500],
    halfSpreadBps: [1, 2000],
    adverseSelectionBps: [1, 2000],
    maxHalfSpreadBps: [1, 4000],
    repriceBps: [1, 1000],
    ttlSeconds: [30, 86400],
    pollMs: [1000, 60000],
    cutoffBufferSeconds: [30, 86400],
    maxFeedAgeMs: [1000, 900000],
    maxProbabilitySpreadX6: [1, 200000],
    probabilityFloorX6: [1, 100000],
    jumpBps: [1, 5000],
    probabilityJumpX6: [1, 500000],
    cooldownMs: [1000, 3600000],
    maxDrawdownBps: [1, 5000],
    maxTransferFeeBps: [0, 1000],
    maxLegDispersionBps: [1, 5000],
  };
  for (const [field, [low, high]] of Object.entries(ranges)) {
    const value = result[field as keyof Settings];
    if (typeof value !== "number" || !Number.isInteger(value) || value < low || value > high)
      throw new Error(`Invalid ${field}`);
  }
  if (typeof result.allowStaleDevnetSpot !== "boolean")
    throw new Error("Invalid allowStaleDevnetSpot");
  if (
    result.ttlSeconds * 1000 < result.pollMs * 3 ||
    result.maxHalfSpreadBps < result.halfSpreadBps ||
    result.halfSpreadBps + result.levelSpacingBps * (result.quoteLevels - 1) >
      result.maxHalfSpreadBps ||
    result.repriceBps > result.halfSpreadBps
  )
    throw new Error("Invalid refresh/spread policy");
  if (!unsigned(result.minSolLamports) || !unsigned(result.dailySolBudgetLamports))
    throw new Error("Positive SOL reserve and spending limit required");
  const seen = new Set<string>();
  const positive = (value: unknown) => typeof value === "string" && decimal(value, 18) > 0n;
  for (const m of result.markets) {
    address(m.market);
    address(m.quoteMint);
    if (
      !Array.isArray(m.baseMints) ||
      m.baseMints.length < 1 ||
      m.baseMints.length > MAX_BASES ||
      !Array.isArray(m.baseInventories) ||
      m.baseInventories.length !== m.baseMints.length ||
      !Array.isArray(m.basePriceMultipliers) ||
      m.basePriceMultipliers.length !== m.baseMints.length
    )
      throw new Error("Configure 1-3 issuer legs, each with a seed and reviewed price multiplier");
    for (const mint of m.baseMints) address(mint);
    if (
      m.referenceMints !== undefined &&
      (!Array.isArray(m.referenceMints) ||
        m.referenceMints.length < 1 ||
        new Set(m.referenceMints).size !== m.referenceMints.length ||
        m.referenceMints.some((mint) => !m.baseMints.includes(mint)))
    )
      throw new Error("referenceMints must be a non-empty, distinct subset of baseMints");
    if (
      seen.has(m.market) ||
      m.baseMints.includes(m.quoteMint) ||
      new Set(m.baseMints).size !== m.baseMints.length
    )
      throw new Error("Duplicate/invalid market allocation");
    seen.add(m.market);
    if (!Number.isInteger(m.gapBps) || Math.abs(m.gapBps) > 7500)
      throw new Error("Invalid conditional gap");
    for (const value of [
      m.quoteInventory,
      m.orderQuote,
      m.quotePriceMultiplier,
      ...m.basePriceMultipliers,
    ])
      if (!positive(value)) throw new Error("Positive allocation/unit conversion required");
    for (const value of m.baseInventories)
      if (typeof value !== "string" || decimal(value, 18) < 0n)
        throw new Error("Invalid issuer seed");
    if (m.targetShares !== undefined && !positive(m.targetShares))
      throw new Error("Invalid target share position");
    if (m.targetShares === undefined && m.baseInventories.every((v) => decimal(v, 18) === 0n))
      throw new Error("A quote-only allocation needs an explicit targetShares");
    if (decimal(m.orderQuote, 18) > decimal(m.quoteInventory, 18) / 4n)
      throw new Error("One quote may use at most 25% of branch quote inventory");
  }
  return result;
}
