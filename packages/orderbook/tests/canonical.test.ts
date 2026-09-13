import { expect, test } from "bun:test";
import { canonicalParse, canonicalStringify, hashCanonical } from "../src/canonical.ts";

test("canonical operational values preserve bigints and stable object ordering", () => {
  const value = { z: [null, true, false, "text", 0, -1, 1n << 256n, -42n], a: {} };
  expect(canonicalParse<typeof value>(canonicalStringify(value))).toEqual(value);
  expect(canonicalStringify(value)).toBe(canonicalStringify({ a: {}, z: value.z }));
  expect(hashCanonical(value)).toBe(hashCanonical({ a: {}, z: value.z }));
  expect(hashCanonical(1n)).not.toBe(hashCanonical("1"));
  expect(canonicalStringify([value, value])).toBe(
    `[${canonicalStringify(value)},${canonicalStringify(value)}]`,
  );
  expect(canonicalParse<bigint>('{"$bigint":"0"}')).toBe(0n);
});

test("canonical values reject cycles, unsupported types and malformed bigint encodings", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const value of [
    cyclic,
    undefined,
    () => 0,
    Symbol(),
    0.5,
    Number.NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    expect(() => canonicalStringify(value)).toThrow();
  for (const value of ["01", "-0", "1.2", "0x10", "", 1, null])
    expect(() => canonicalParse(JSON.stringify({ $bigint: value }))).toThrow();
  expect(
    canonicalParse<{ $bigint: string; extra: boolean }>('{"$bigint":"1","extra":true}'),
  ).toEqual({ $bigint: "1", extra: true });
});
