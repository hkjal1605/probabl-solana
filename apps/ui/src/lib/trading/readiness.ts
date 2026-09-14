import type { MarketView } from "@/types/api";
type MarketWindow = Pick<MarketView, "lifecycle" | "tradingOpen" | "cutoff">;
export function localTradingStatus(market: MarketWindow, now = Date.now()) {
  const open = Date.parse(market.tradingOpen),
    cutoff = Date.parse(market.cutoff);
  if (!Number.isFinite(open) || !Number.isFinite(cutoff)) return "unavailable";
  if (now >= cutoff) return "closed";
  if (market.lifecycle === "scheduled" || now < open) return "scheduled";
  return market.lifecycle === "open" ? "ready" : "closed";
}
export function readinessMessage(reason?: string) {
  return reason === "closed"
    ? "Trading has closed for this market."
    : reason === "scheduled"
      ? "Trading has not opened yet."
      : reason === "paused"
        ? "Trading is paused by the protocol."
        : "Checking trading availability…";
}

/** Always performs a new check for a user action, never a cached UI boolean. */
export async function requireTradingReady(
  market: MarketWindow,
  read: () => Promise<{ healthy: boolean; reason?: string }>,
  now = Date.now,
) {
  const current = localTradingStatus(market, now());
  if (current !== "ready") throw new Error(readinessMessage(current));
  let result: Awaited<ReturnType<typeof read>>;
  try {
    result = await read();
  } catch {
    throw new Error("Cannot verify trading availability. Please try again shortly.");
  }
  if (result.healthy !== true) throw new Error(readinessMessage(result.reason));
  if (localTradingStatus(market, now()) !== "ready")
    throw new Error("Trading has closed for this market.");
}
