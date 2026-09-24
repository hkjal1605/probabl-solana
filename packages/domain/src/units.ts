/** @deprecated v2 (single base token, raw-unit prices). Kept for legacy consumers; new markets are v3 {@link ShareUnits}. */
export const PROTOCOL_VERSION = 2;
/** @deprecated v2 price format. See {@link SHARE_PRICE_FORMAT}. */
export const PRICE_FORMAT = "raw-unit-ratio-x18" as const;

/** v3 multi-issuer markets: quantities are share units, prices quote raw per share unit x 1e18. */
export const SHARE_PROTOCOL_VERSION = 3;
export const SHARE_PRICE_FORMAT = "share-unit-ratio-x18" as const;

export const MAX_TOKEN_DECIMALS = 36;
export const MAX_ORDER_UINT128 = (1n << 128n) - 1n;

/** @deprecated v2 single-base market units. Use {@link ShareUnits} for protocol v3. */
export interface MarketUnits {
  baseTokenDecimals: number;
  quoteTokenDecimals: number;
  protocolVersion: number;
  priceFormat: typeof PRICE_FORMAT;
}

/**
 * v3 market units. One market trades up to three issuer tokens ("legs") of one
 * asset against one quote. Quantities are share units (`10^-shareDecimals` of
 * one economic share); each leg converts share units to its own raw amount with
 * its scale and live multiplier.
 */
export interface ShareUnits {
  shareDecimals: number;
  quoteTokenDecimals: number;
  protocolVersion: number;
  priceFormat: typeof SHARE_PRICE_FORMAT;
}

export type AnyMarketUnits = MarketUnits | ShareUnits;

/** A listed base leg's display precision (raw claim/token amounts use the leg decimals). */
export interface LegUnits {
  decimals: number;
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

/** @deprecated Reject legacy or missing v2 metadata; never infer USDG's precision from a symbol. */
export function assertMarketUnits(value: unknown): asserts value is MarketUnits {
  if (!value || typeof value !== "object") throw new TypeError("Market units are required");
  const units = value as MarketUnits;
  if (units.protocolVersion !== PROTOCOL_VERSION || units.priceFormat !== PRICE_FORMAT) {
    throw new RangeError("Unsupported market price semantics; v2 raw-unit ratio required");
  }
  tokenDecimals(units.baseTokenDecimals);
  tokenDecimals(units.quoteTokenDecimals);
}

/** Reject anything but v3 share-unit semantics with verified decimals. */
export function assertShareUnits(value: unknown): asserts value is ShareUnits {
  if (!value || typeof value !== "object") throw new TypeError("Market units are required");
  const units = value as ShareUnits;
  if (
    units.protocolVersion !== SHARE_PROTOCOL_VERSION ||
    units.priceFormat !== SHARE_PRICE_FORMAT
  ) {
    throw new RangeError("Unsupported market price semantics; v3 share-unit ratio required");
  }
  tokenDecimals(units.shareDecimals);
  tokenDecimals(units.quoteTokenDecimals);
}

const isShareUnits = (units: AnyMarketUnits): units is ShareUnits =>
  (units as ShareUnits).priceFormat === SHARE_PRICE_FORMAT;

/** Decimals of the quantity unit: share decimals (v3) or base token decimals (v2). */
export function quantityDecimals(units: AnyMarketUnits): number {
  if (isShareUnits(units)) {
    assertShareUnits(units);
    return units.shareDecimals;
  }
  assertMarketUnits(units);
  return units.baseTokenDecimals;
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

/** Human share quantity -> share units (v3), or base raw units (v2). */
export const parseShareAmount = (value: string, units: AnyMarketUnits): bigint =>
  parseScaled(value, quantityDecimals(units));

/** Share units (v3) or base raw units (v2) -> exact human quantity. */
export const formatShareAmount = (value: bigint, units: AnyMarketUnits): string =>
  formatScaled(value, quantityDecimals(units));

/** Raw amount of a leg's issuer token or YES/NO claim -> exact human amount in that leg's decimals. */
export const formatLegAmount = (raw: bigint, leg: LegUnits): string =>
  formatTokenAmount(raw, leg.decimals);

export const parseLegAmount = (value: string, leg: LegUnits): bigint =>
  parseTokenAmount(value, leg.decimals);

/**
 * Share units per leg raw unit before the issuer multiplier: `10^(legDecimals - shareDecimals)`.
 * Mirrors the SDK's `shareScale` and the on-chain `BaseLeg.scale`.
 */
export function legScale(legDecimals: number, shareDecimals: number): bigint {
  tokenDecimals(legDecimals);
  tokenDecimals(shareDecimals);
  if (legDecimals < shareDecimals || legDecimals - shareDecimals > 19)
    throw new RangeError("Base leg decimals are incompatible with the market share unit");
  return pow10(legDecimals - shareDecimals);
}

/** Decimal exponent of a price: 18 + quote decimals - quantity (share) decimals. */
export const priceExponent = (units: AnyMarketUnits): number => {
  const quantity = quantityDecimals(units);
  return 18 + units.quoteTokenDecimals - quantity;
};

/** human quote/share -> quote raw/share unit * 1e18 (v3) or quote raw/base raw * 1e18 (v2). Reject dust and uint128 overflow. */
export function parsePriceRawX18(value: string, units: AnyMarketUnits): bigint {
  const raw = parseScaled(value, priceExponent(units));
  if (raw <= 0n || raw > MAX_ORDER_UINT128)
    throw new RangeError("Price is outside uint128 positive range");
  return raw;
}

export const formatPriceRawX18 = (value: bigint, units: AnyMarketUnits): string =>
  formatScaled(value, priceExponent(units));
