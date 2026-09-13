import { expect, test } from "bun:test";
import { hashResolutionCommitment, type ResolutionCommitmentInput } from "./resolution.ts";

test("resolution commitment binds each final argument and deployment domain", () => {
  const input: ResolutionCommitmentInput = {
    chainId: 31337n,
    controller: "0x1111111111111111111111111111111111111111",
    marketId: `0x${"22".repeat(32)}`,
    yesPayout: 1n,
    noPayout: 0n,
    payoutDenominator: 1n,
    evidenceHash: `0x${"33".repeat(32)}`,
    evidenceUri: "ipfs://approved-packet",
  };
  const expected = hashResolutionCommitment(input);
  const mutations: Partial<ResolutionCommitmentInput>[] = [
    { chainId: 31338n },
    { controller: "0x2222222222222222222222222222222222222222" },
    { marketId: `0x${"44".repeat(32)}` },
    { yesPayout: 0n },
    { noPayout: 1n },
    { payoutDenominator: 2n },
    { evidenceHash: `0x${"55".repeat(32)}` },
    { evidenceUri: "ipfs://approved-packet/" },
  ];
  for (const mutation of mutations)
    expect(hashResolutionCommitment({ ...input, ...mutation })).not.toBe(expected);
});
