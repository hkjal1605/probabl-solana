import { describe, expect, test } from "bun:test";
import { short } from "@/lib/format";

describe("operator identifiers", () => {
  test("keeps short values and abbreviates long hashes without ambiguity", () => {
    expect(short("draft-7")).toBe("draft-7");
    expect(short("0x1234567890abcdef1234567890abcdef12345678", 6)).toBe("0x123456…345678");
  });
});
