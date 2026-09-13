import { ponder as registry } from "ponder:registry";
import { logger } from "./logger.ts";

/** A completed handler is not a finalized block; Ponder still owns commit/reorg processing. */
export const ponder: typeof registry = {
  on(name, handler) {
    registry.on(name, async (input) => {
      const event = input.event as {
        id?: string;
        block?: { number: bigint; hash: string };
        transaction?: { hash: string };
        args?: Record<string, unknown>;
      };
      const fields: Record<string, unknown> = {
        eventName: name,
        eventId: event.id,
        chainId: input.context.chain.id,
        blockNumber: event.block?.number,
        blockHash: event.block?.hash,
        transactionHash: event.transaction?.hash,
      };
      for (const key of [
        "marketId",
        "orderHash",
        "buyOrderHash",
        "sellOrderHash",
        "fillQuantity",
        "executionPriceRawX18",
        "newState",
        "paused",
        "success",
      ]) {
        if (event.args?.[key] !== undefined) fields[key] = event.args[key];
      }
      try {
        await handler(input);
        const quiet = /:(?:block|Transfer|TransferSingle|TransferBatch|ApprovalForAll|URI)$/.test(
          name,
        );
        if (name === "ProtocolBlock:block" && event.block && event.block.number % 100n === 0n)
          logger.info("indexer.progress", { ...fields, stage: "handler-completed" });
        else if (quiet)
          logger.debug("indexer.event.applied", { ...fields, stage: "handler-completed" });
        else logger.info("indexer.event.applied", { ...fields, stage: "handler-completed" });
      } catch (error) {
        logger.error("indexer.event.failed", { ...fields, error });
        throw error; // Never swallow a failed projection or allow Ponder to advance past it.
      }
    });
  },
};
