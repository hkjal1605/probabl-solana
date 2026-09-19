export const PROTOCOL_VERSION = 2;

export const PRICE_FORMAT = "raw-unit-ratio-x18" as const;
export const MAX_TOKEN_DECIMALS = 36;
export const MAX_ORDER_UINT128 = (1n << 128n) - 1n;

export interface MarketUnits {
  baseTokenDecimals: number;
  quoteTokenDecimals: number;
  protocolVersion: number;
  priceFormat: typeof PRICE_FORMAT;
}

export function tokenDecimals(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_TOKEN_DECIMALS
  ) {
    throw new RangeError("Token decimals must be a verified integer between 0 and 36");
  }
  return value;
}

/** Reject legacy or missing metadata; never infer USDG's precision from a symbol. */
export function assertMarketUnits(value: unknown): asserts value is MarketUnits {
  if (!value || typeof value !== "object") throw new TypeError("Market units are required");
  const units = value as MarketUnits;
  if (units.protocolVersion !== PROTOCOL_VERSION || units.priceFormat !== PRICE_FORMAT) {
    throw new RangeError("Unsupported market price semantics; v2 raw-unit ratio required");
  }
  tokenDecimals(units.baseTokenDecimals);
  tokenDecimals(units.quoteTokenDecimals);
}

const pow10 = (exponent: number): bigint => 10n ** BigInt(exponent);

/** Exact unsigned decimal input, with no floating-point conversion or rounding. */
function parseScaled(value: string, exponent: number): bigint {
  if (
    typeof value !== "string" ||
    value.length > 160 ||
    !/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)
  ) {
    throw new RangeError("Expected an unsigned plain decimal string");
  }
  const [whole = "0", fraction = ""] = value.split(".");
  const digits = BigInt(whole + fraction);
  const shift = exponent - fraction.length;
  if (shift >= 0) return digits * pow10(shift);
  const divisor = pow10(-shift);
  if (digits % divisor !== 0n)
    throw new RangeError("Value is not exactly representable in raw units");
  return digits / divisor;
}

function formatScaled(value: bigint, exponent: number): string {
  if (typeof value !== "bigint" || value < 0n)
    throw new RangeError("Raw value must be non-negative");
  if (exponent <= 0) return (value * pow10(-exponent)).toString();
  const digits = value.toString().padStart(exponent + 1, "0");
  const fraction = digits.slice(-exponent).replace(/0+$/, "");
  return digits.slice(0, -exponent) + (fraction ? `.${fraction}` : "");
}

export const parseTokenAmount = (value: string, decimals: number): bigint =>
  parseScaled(value, tokenDecimals(decimals));

export const formatTokenAmount = (value: bigint, decimals: number): string =>
  formatScaled(value, tokenDecimals(decimals));

const priceExponent = (units: MarketUnits): number => {
  assertMarketUnits(units);
  return 18 + units.quoteTokenDecimals - units.baseTokenDecimals;
};

/** human quote/base -> signed raw quote/raw base * 1e18. Reject dust and uint128 overflow. */
export function parsePriceRawX18(value: string, units: MarketUnits): bigint {
  const raw = parseScaled(value, priceExponent(units));
  if (raw <= 0n || raw > MAX_ORDER_UINT128)
    throw new RangeError("Price is outside uint128 positive range");
  return raw;
}

export const formatPriceRawX18 = (value: bigint, units: MarketUnits): string =>
  formatScaled(value, priceExponent(units));
