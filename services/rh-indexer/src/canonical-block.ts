import type { IndexerQueries } from "@conditional-stocks/db/indexer/reads";
import type { Hex } from "viem";

interface State {
  indexedBlock: bigint;
  indexedBlockHash: Hex;
}
interface RpcBlock {
  number: bigint | null;
  hash: Hex | null;
  parentHash: Hex;
  timestamp: bigint;
}
interface Reader {
  getBlock(input: { blockNumber: bigint }): Promise<RpcBlock>;
}

export class CanonicalBlockUnavailable extends Error {}
export class CanonicalBlockReorged extends Error {}

/** Cache misses never write to PostgreSQL or start an unbounded historical scan.
 * Coalesce simultaneous misses only; do not cache an old branch across requests.
 */
export function createCanonicalBlockReader(
  queries: Pick<IndexerQueries, "canonicalBlock">,
  reader: Reader,
  chainId: number,
) {
  type Block = { number: bigint; hash: Hex; parentHash: Hex; timestamp: bigint; chainId: bigint };
  const pending = new Map<string, Promise<Block>>();
  return async (number: bigint, state: State, verifyRpc = false): Promise<Block> => {
    if (number < 0n || number > state.indexedBlock)
      throw new CanonicalBlockUnavailable("block is outside the indexed range");
    const retained = await queries.canonicalBlock(number);
    if (retained && !verifyRpc) return retained;
    const key = `${state.indexedBlockHash}:${number}`;
    const existing = pending.get(key);
    const checkRetained = (block: Block) => {
      if (retained && retained.hash.toLowerCase() !== block.hash.toLowerCase())
        throw new CanonicalBlockReorged("indexed block is no longer canonical");
      return block;
    };
    if (existing) return checkRetained(await existing);
    if (pending.size >= 64)
      throw new CanonicalBlockUnavailable("historical block lookup busy; retry");
    const request = (async (): Promise<Block> => {
      try {
        const block = await reader.getBlock({ blockNumber: number });
        // Read the saved head again AFTER the fallback. If indexing/RPC branches
        // diverged during the request, consumers must retry instead of using mixed state.
        const head =
          number === state.indexedBlock
            ? block
            : await reader.getBlock({ blockNumber: state.indexedBlock });
        if (head.number !== state.indexedBlock || !head.hash)
          throw new CanonicalBlockUnavailable("invalid indexed head response");
        if (
          head.hash?.toLowerCase() !== state.indexedBlockHash.toLowerCase() ||
          (retained && retained.hash.toLowerCase() !== block.hash?.toLowerCase())
        )
          throw new CanonicalBlockReorged("indexed block is no longer canonical");
        if (
          block.number !== number ||
          !block.hash ||
          !block.parentHash ||
          block.timestamp < 0n ||
          block.timestamp > head.timestamp
        )
          throw new CanonicalBlockUnavailable("invalid historical block response");
        return {
          number,
          hash: block.hash,
          parentHash: block.parentHash,
          timestamp: block.timestamp,
          chainId: BigInt(chainId),
        };
      } catch (error) {
        if (error instanceof CanonicalBlockReorged || error instanceof CanonicalBlockUnavailable)
          throw error;
        throw new CanonicalBlockUnavailable("historical RPC block unavailable; retry");
      }
    })();
    pending.set(key, request);
    try {
      return checkRetained(await request);
    } finally {
      pending.delete(key);
    }
  };
}
