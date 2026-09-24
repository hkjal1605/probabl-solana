import type { ProbabilityView } from "../types/api";

export function expireProbability(
  value: ProbabilityView,
  now = Date.now(),
  maxAgeMs = 30_000,
): ProbabilityView {
  const at = value.observedAt ? Date.parse(value.observedAt) : NaN;
  if (value.quality === "disconnected") return value;
  return !Number.isFinite(at) || now - at > maxAgeMs || at > now + 5000
    ? { ...value, quality: "stale" }
    : value;
}

/** Display-only tolerance: the source's freshness window plus the read cache TTL. */
export function expireCachedProbability(value: ProbabilityView, now = Date.now()): ProbabilityView {
  return expireProbability(value, now, 90_000);
}

/** A transport/quality transition with no new midpoint must not erase the last
 * display value. Preserve its original timestamp so it cannot appear freshly observed. */
export function retainProbabilityDisplay(
  previous: ProbabilityView,
  next: ProbabilityView,
): ProbabilityView {
  return next.value === null && previous.value !== null
    ? { ...next, observedAt: previous.observedAt, value: previous.value }
    : next;
}
