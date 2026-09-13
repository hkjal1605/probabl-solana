import type { ProbabilityView } from "./types";

const qualities = new Set([
  "crossed",
  "disconnected",
  "empty",
  "low-depth",
  "one-sided",
  "stale",
  "valid",
]);
const scaled = (value: unknown): number | null => {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,6})$/.test(value) ||
    BigInt(value) > 1_000_000n
  )
    throw new Error("invalid probability");
  return Number(value) / 1_000_000;
};

export function parseProbabilityMessage(input: unknown, conditionId: string): ProbabilityView {
  const envelope = input as { topic?: string; value?: Record<string, unknown> };
  const tick = envelope?.value;
  if (
    envelope?.topic !== `probability.${conditionId}` ||
    !tick ||
    tick.conditionId !== conditionId ||
    typeof tick.quality !== "string" ||
    !qualities.has(tick.quality)
  )
    throw new Error("invalid probability stream identity or quality");
  if (typeof tick.observedAtMs !== "string" || !/^[0-9]{1,16}$/.test(tick.observedAtMs))
    throw new Error("invalid probability timestamp");
  const at = Number(tick.observedAtMs);
  if (!Number.isSafeInteger(at) || at > 8_640_000_000_000_000)
    throw new Error("invalid probability timestamp");
  const value = scaled(tick.midpointX6);
  const bid = scaled(tick.bestBidX6);
  const ask = scaled(tick.bestAskX6);
  if (
    tick.quality === "valid" &&
    (value === null || bid === null || ask === null || bid >= ask || value < bid || value > ask)
  )
    throw new Error("invalid usable probability");
  return {
    ask,
    bid,
    observedAt: new Date(at).toISOString(),
    quality: tick.quality as ProbabilityView["quality"],
    value: tick.quality === "valid" ? value : null,
  };
}

export function expireProbability(
  value: ProbabilityView,
  now = Date.now(),
  maxAgeMs = 30_000,
): ProbabilityView {
  const at = value.observedAt ? Date.parse(value.observedAt) : NaN;
  if (value.quality === "disconnected") return { ...value, value: null };
  return !Number.isFinite(at) || now - at > maxAgeMs || at > now + 5000
    ? { ...value, quality: "stale", value: null }
    : value;
}
