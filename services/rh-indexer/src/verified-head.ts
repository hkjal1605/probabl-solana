import type { Hex } from "viem";
import type { IndexerEnvironment } from "./environment.ts";

interface Head {
  indexedBlock: bigint;
  indexedBlockHash: Hex;
  indexedBlockTimestamp: bigint;
  confirmedBlock: bigint;
  finalizedBlock: bigint;
}
interface Block {
  number: bigint | null;
  hash: Hex | null;
  timestamp: bigint;
}
export interface HeadReader {
  getBlock(
    input: { blockNumber: bigint } | { blockTag: "latest" | "safe" | "finalized" },
  ): Promise<Block>;
}
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** RPC failures never fall back to optimistic depth-based mainnet finality. */
export async function verifiedHead<T extends Head>(
  state: T,
  reader: HeadReader,
  environment: Pick<
    IndexerEnvironment,
    | "finalityMode"
    | "confirmationMode"
    | "confirmationBlockCount"
    | "finalityBlockCount"
    | "maxHeadAgeSeconds"
  >,
  nowSeconds = BigInt(Math.floor(Date.now() / 1000)),
): Promise<T> {
  if (
    state.indexedBlockTimestamp > nowSeconds + 5n ||
    nowSeconds - state.indexedBlockTimestamp > BigInt(environment.maxHeadAgeSeconds)
  ) {
    throw new Error("indexed head is stale or timestamp is invalid");
  }
  const canonical = await reader.getBlock({ blockNumber: state.indexedBlock });
  if (canonical.hash?.toLowerCase() !== state.indexedBlockHash.toLowerCase())
    throw new Error("indexed head is not canonical");
  const depth =
    state.indexedBlock > environment.confirmationBlockCount
      ? state.indexedBlock - environment.confirmationBlockCount
      : 0n;
  if (environment.finalityMode === "local-depth") {
    return {
      ...state,
      confirmedBlock: depth,
      finalizedBlock:
        state.indexedBlock > environment.finalityBlockCount
          ? state.indexedBlock - environment.finalityBlockCount
          : 0n,
    };
  }
  const [safe, finalized] = await Promise.all([
    reader.getBlock({ blockTag: "safe" }),
    reader.getBlock({ blockTag: "finalized" }),
  ]);
  if (
    safe.number === null ||
    finalized.number === null ||
    !safe.hash ||
    !finalized.hash ||
    finalized.number > safe.number
  )
    throw new Error("invalid RPC finality heads");
  const confirmedBlock =
    environment.confirmationMode === "sequencer-depth"
      ? depth
      : min(depth, environment.confirmationMode === "finalized" ? finalized.number : safe.number);
  return { ...state, confirmedBlock, finalizedBlock: min(confirmedBlock, finalized.number) };
}
