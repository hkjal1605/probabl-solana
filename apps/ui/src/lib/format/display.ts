import { formatPriceRawX18, formatTokenAmount, type MarketUnits } from "@conditional-stocks/domain";

const compact = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, notation: "compact" });
const decimal = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const usd = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 2,
  style: "currency",
});

export const formatUsd = (value: number | null) =>
  value === null ? "Unavailable" : usd.format(value);
export const formatCompactUsd = (value: number) => `$${compact.format(value)}`;
export const formatProbability = (value: number | null) =>
  value === null ? "Withheld" : `${Math.round(value * 100)}%`;
export const formatNumber = (value: number | null, digits?: number) =>
  value === null || !Number.isFinite(value)
    ? "—"
    : digits === undefined
      ? decimal.format(value)
      : new Intl.NumberFormat("en-US", {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        }).format(value);
export const shortAddress = (value: string, size = 4) =>
  value.length <= size * 2 + 2 ? value : `${value.slice(0, size + 2)}…${value.slice(-size)}`;
export const formatTime = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(value),
      )
    : "Not available";
export const timeUntil = (value: string, now = Date.now()) => {
  const milliseconds = new Date(value).getTime() - now;
  if (milliseconds <= 0) return "Cutoff reached";
  const days = Math.floor(milliseconds / 86_400_000);
  const hours = Math.floor((milliseconds % 86_400_000) / 3_600_000);
  if (days === 0 && hours === 0)
    return `${Math.max(1, Math.ceil(milliseconds / 60_000))}m remaining`;
  return days > 0 ? `${days}d ${hours}h remaining` : `${hours}h remaining`;
};
// Approximate numbers are exclusively for visual formatting, never order construction.
export const displayPrice = (value: string, units: MarketUnits) =>
  Number(formatPriceRawX18(BigInt(value), units));
export const tokenAmount = (value: string, decimals: number) =>
  Number(formatTokenAmount(BigInt(value), decimals));
