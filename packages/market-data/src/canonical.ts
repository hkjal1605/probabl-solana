import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";

export type Hex = `0x${string}`;
export const isHex32 = (value: unknown): value is Hex =>
  typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);

export type JsonValue =
  | boolean
  | null
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export class MarketDataError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "MarketDataError";
  }
}

const canonicalValue = (value: unknown, path: string, seen: Set<object>): JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new MarketDataError("INVALID_JSON", `${path} is not finite`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new MarketDataError("INVALID_JSON", `${path} contains a cycle`);
    seen.add(value);
    const result = value.map((item, index) => canonicalValue(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new MarketDataError("INVALID_JSON", `${path} contains a cycle`);
    seen.add(value);
    const record = value as Record<string, unknown>;
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol") {
        throw new MarketDataError("INVALID_JSON", `${path}.${key} is not JSON`);
      }
      result[key] = canonicalValue(item, `${path}.${key}`, seen);
    }
    seen.delete(value);
    return result;
  }
  throw new MarketDataError("INVALID_JSON", `${path} is not JSON`);
};

export const canonicalize = (value: unknown): JsonValue => canonicalValue(value, "$", new Set());

export const canonicalStringify = (value: unknown): string => JSON.stringify(canonicalize(value));

export const hashCanonical = (value: unknown): Hex =>
  `0x${bytesToHex(keccak_256(new TextEncoder().encode(canonicalStringify(value))))}`;

export const object = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MarketDataError("INVALID_INPUT", `${name} must be an object`);
  }
  return value as Record<string, unknown>;
};

export const requiredString = (value: unknown, name: string, maximumLength = 4_096): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new MarketDataError("INVALID_INPUT", `${name} must be 1-${maximumLength} characters`);
  }
  return value;
};

export const decimalInteger = (value: unknown, name: string, allowZero = false): string => {
  const pattern = allowZero ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/;
  if (typeof value !== "string" || value.length > 78 || !pattern.test(value)) {
    throw new MarketDataError("INVALID_INPUT", `${name} must be a decimal integer string`);
  }
  return value;
};
