import { type Hex, isHex } from "viem";

import {
  decimalInteger,
  hashCanonical,
  MarketDataError,
  object,
  requiredString,
} from "./canonical.ts";

export interface PolymarketOutcome {
  indexSet: "1" | "2";
  label: "NO" | "YES";
  tokenId: string;
}

export interface NormalizedPolymarketMarket {
  active: boolean;
  canonicalUrl: string;
  closed: boolean;
  conditionId: Hex;
  endTime: string;
  gammaMarketId: string;
  mappingHash: Hex;
  negRisk: false;
  outcomes: [PolymarketOutcome, PolymarketOutcome];
  question: string;
  resolutionSource: string;
  resolutionStatus: string | null;
  rules: string;
  schemaVersion: 1;
  slug: string;
}

const stringArray = (value: unknown, name: string): string[] => {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new MarketDataError("INVALID_METADATA", `${name} is not valid JSON`);
    }
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new MarketDataError("INVALID_METADATA", `${name} must be a string array`);
  }
  return parsed;
};

const boolean = (value: unknown, name: string): boolean => {
  if (typeof value !== "boolean") {
    throw new MarketDataError("INVALID_METADATA", `${name} must be boolean`);
  }
  return value;
};

const isoTime = (value: unknown, name: string): string => {
  const input = requiredString(value, name, 128);
  const timestamp = Date.parse(input);
  if (!Number.isFinite(timestamp))
    throw new MarketDataError("INVALID_METADATA", `${name} is invalid`);
  return new Date(timestamp).toISOString();
};

const optionalString = (value: unknown, name: string): string | null => {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, name);
};

export const normalizeGammaMarket = (input: unknown): NormalizedPolymarketMarket => {
  const raw = object(input, "Gamma market");
  const conditionId = requiredString(raw.conditionId, "conditionId", 66).toLowerCase();
  if (!isHex(conditionId, { strict: true }) || conditionId.length !== 66) {
    throw new MarketDataError("INVALID_METADATA", "conditionId must be bytes32");
  }
  if (raw.negRisk === true) {
    throw new MarketDataError(
      "UNSUPPORTED_MARKET",
      "negative-risk markets are not supported in v1",
    );
  }
  const labels = stringArray(raw.outcomes, "outcomes");
  const tokenIds = stringArray(raw.clobTokenIds, "clobTokenIds");
  if (labels.length !== 2 || tokenIds.length !== 2) {
    throw new MarketDataError("UNSUPPORTED_MARKET", "v1 requires exactly two outcomes");
  }
  const normalizedLabels = labels.map((label) => label.trim().toUpperCase());
  if (
    normalizedLabels.filter((label) => label === "YES").length !== 1 ||
    normalizedLabels.filter((label) => label === "NO").length !== 1
  ) {
    throw new MarketDataError("UNSUPPORTED_MARKET", "outcomes must contain exactly YES and NO");
  }
  const outcomes = labels.map(
    (_, index): PolymarketOutcome => ({
      indexSet: index === 0 ? "1" : "2",
      label: normalizedLabels[index] as "NO" | "YES",
      tokenId: decimalInteger(tokenIds[index], `clobTokenIds[${index}]`),
    }),
  ) as [PolymarketOutcome, PolymarketOutcome];
  if (outcomes[0].tokenId === outcomes[1].tokenId) {
    throw new MarketDataError("INVALID_METADATA", "outcome token IDs must differ");
  }
  const slug = requiredString(raw.slug, "slug", 512);
  const mapping = {
    conditionId,
    outcomes,
  };
  return {
    active: boolean(raw.active, "active"),
    canonicalUrl: `https://polymarket.com/event/${encodeURIComponent(slug)}`,
    closed: boolean(raw.closed, "closed"),
    conditionId: conditionId as Hex,
    endTime: isoTime(raw.endDate ?? raw.endDateIso, "endDate"),
    gammaMarketId: requiredString(raw.id, "id", 256),
    mappingHash: hashCanonical(mapping),
    negRisk: false,
    outcomes,
    question: requiredString(raw.question, "question"),
    resolutionSource: optionalString(raw.resolutionSource, "resolutionSource") ?? "unspecified",
    resolutionStatus: optionalString(raw.umaResolutionStatus, "umaResolutionStatus"),
    rules: requiredString(raw.description, "description", 64_000),
    schemaVersion: 1,
    slug,
  };
};

export const yesOutcome = (market: NormalizedPolymarketMarket): PolymarketOutcome => {
  const outcome = market.outcomes.find((item) => item.label === "YES");
  if (!outcome) throw new MarketDataError("INVALID_METADATA", "YES outcome is missing");
  return outcome;
};

export const noOutcome = (market: NormalizedPolymarketMarket): PolymarketOutcome => {
  const outcome = market.outcomes.find((item) => item.label === "NO");
  if (!outcome) throw new MarketDataError("INVALID_METADATA", "NO outcome is missing");
  return outcome;
};
