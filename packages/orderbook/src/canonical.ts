import { type Hex, keccak256, toBytes } from "viem";

import { CanonicalInputError } from "./errors.ts";

const BIGINT_TAG = "$bigint";

const encodeCanonical = (value: unknown, seen: Set<object>): string => {
  if (value === null) return "null";
  if (typeof value === "bigint") {
    return `{"${BIGINT_TAG}":${JSON.stringify(value.toString())}}`;
  }
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new CanonicalInputError("canonical numbers must be safe integers");
    }
    return String(value);
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    throw new CanonicalInputError(`unsupported canonical value: ${typeof value}`);
  }

  if (seen.has(value)) throw new CanonicalInputError("canonical value contains a cycle");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => encodeCanonical(item, seen)).join(",")}]`;
    }

    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encodeCanonical(record[key], seen)}`);
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
};

export const canonicalStringify = (value: unknown): string => encodeCanonical(value, new Set());

export const canonicalParse = <T>(value: string): T =>
  JSON.parse(value, (_key, item: unknown) => {
    if (
      typeof item === "object" &&
      item !== null &&
      !Array.isArray(item) &&
      Object.keys(item).length === 1 &&
      BIGINT_TAG in item
    ) {
      const encoded = (item as Record<string, unknown>)[BIGINT_TAG];
      if (typeof encoded !== "string" || !/^(0|-?[1-9][0-9]*)$/.test(encoded)) {
        throw new CanonicalInputError("invalid encoded bigint");
      }
      return BigInt(encoded);
    }
    return item;
  }) as T;

export const hashCanonical = (value: unknown): Hex => keccak256(toBytes(canonicalStringify(value)));
