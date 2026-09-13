import { type Address, encodeAbiParameters, type Hex, keccak256, toBytes } from "viem";

export interface ResolutionCommitmentInput {
  chainId: bigint;
  controller: Address;
  marketId: Hex;
  yesPayout: bigint;
  noPayout: bigint;
  payoutDenominator: bigint;
  evidenceHash: Hex;
  evidenceUri: string;
}

/** Matches ManualResolutionController.hashResolution, including the exact URI bytes. */
export const hashResolutionCommitment = (input: ResolutionCommitmentInput): Hex =>
  keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "uint256" },
        { type: "address" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        "CONDITIONAL_STOCKS_RESOLUTION_V1",
        input.chainId,
        input.controller,
        input.marketId,
        input.yesPayout,
        input.noPayout,
        input.payoutDenominator,
        input.evidenceHash,
        keccak256(toBytes(input.evidenceUri)),
      ],
    ),
  );
