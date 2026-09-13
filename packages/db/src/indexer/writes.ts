import { quoteForReservation } from "@conditional-stocks/domain";
import type { Virtual } from "ponder";
import type { Address, Hex } from "viem";

import * as schema from "./schema.ts";
import { chainEvent, chainTransaction } from "./schema.ts";

export type IndexerWriter = Pick<
  Virtual.Context<
    {
      chains: Record<string, never>;
      contracts: Record<string, never>;
      accounts: Record<string, never>;
      blocks: Record<string, never>;
    },
    typeof schema,
    never
  >["db"],
  "find" | "insert" | "update" | "delete"
>;
type AppDb = IndexerWriter;

export const findMarket = (db: IndexerWriter, id: Hex) => db.find(schema.market, { id });
export const findOrder = (db: IndexerWriter, id: Hex) => db.find(schema.order, { id });
export const findNonceFloor = (db: IndexerWriter, maker: Address) =>
  db.find(schema.nonceFloor, { maker });

export const insertMarket = (db: IndexerWriter, values: typeof schema.market.$inferInsert) =>
  db.insert(schema.market).values(values);
export const insertOrder = (db: IndexerWriter, values: typeof schema.order.$inferInsert) =>
  db.insert(schema.order).values(values);
export const insertReservation = (
  db: IndexerWriter,
  values: typeof schema.reservation.$inferInsert,
) => db.insert(schema.reservation).values(values);
export const insertFill = (db: IndexerWriter, values: typeof schema.fill.$inferInsert) =>
  db.insert(schema.fill).values(values);
export const addOrderTradingFee = (db: IndexerWriter, orderHash: Hex, amount: bigint) => {
  if (amount < 0n) throw new Error("Trading fee must be nonnegative");
  if (amount === 0n) return;
  return db
    .update(schema.order, { id: orderHash })
    .set((row) => ({ feesPaid: row.feesPaid + amount }));
};
export const insertResolution = (
  db: IndexerWriter,
  values: typeof schema.resolution.$inferInsert,
) => db.insert(schema.resolution).values(values);

export const updateMarket = (
  db: IndexerWriter,
  id: Hex,
  values: Partial<Omit<typeof schema.market.$inferSelect, "id">>,
) => db.update(schema.market, { id }).set(values);
export const updateOrder = (
  db: IndexerWriter,
  id: Hex,
  values: Partial<Omit<typeof schema.order.$inferSelect, "id">>,
) => db.update(schema.order, { id }).set(values);
export const updateReservation = (
  db: IndexerWriter,
  orderHash: Hex,
  values: Partial<Omit<typeof schema.reservation.$inferSelect, "orderHash">>,
) => db.update(schema.reservation, { orderHash }).set(values);

export const upsertNonceFloor = (
  db: IndexerWriter,
  values: typeof schema.nonceFloor.$inferInsert,
) =>
  db
    .insert(schema.nonceFloor)
    .values(values)
    .onConflictDoUpdate({ minimumNonce: values.minimumNonce, updatedBlock: values.updatedBlock });
export const upsertProtocolState = (
  db: IndexerWriter,
  values: typeof schema.protocolState.$inferInsert,
) =>
  db.insert(schema.protocolState).values(values).onConflictDoUpdate({
    pauseCaller: values.pauseCaller,
    pauseReasonHash: values.pauseReasonHash,
    tradingPaused: values.tradingPaused,
    updatedBlock: values.updatedBlock,
  });

/** Called inside Ponder's block transaction; API finality is still independently verified via RPC. */
export async function persistIndexedBlock(
  db: IndexerWriter,
  block: Omit<typeof schema.chainBlock.$inferInsert, "slot">,
  options: {
    confirmationBlockCount: bigint;
    finalityBlockCount: bigint;
    finalityMode: "local-depth" | "rpc-tags";
    blockRetention: number;
  },
) {
  const subtractFloorZero = (value: bigint, amount: bigint) =>
    value > amount ? value - amount : 0n;
  await db
    .insert(schema.chainBlock)
    .values({
      ...block,
      slot: Number(block.number % BigInt(options.blockRetention)),
    })
    .onConflictDoUpdate({
      number: block.number,
      hash: block.hash,
      parentHash: block.parentHash,
      timestamp: block.timestamp,
    });
  const head = {
    confirmedBlock: subtractFloorZero(block.number, options.confirmationBlockCount),
    finalizedBlock:
      options.finalityMode === "local-depth"
        ? subtractFloorZero(block.number, options.finalityBlockCount)
        : 0n,
    indexedBlock: block.number,
    indexedBlockHash: block.hash,
    indexedBlockTimestamp: block.timestamp,
  };
  await db
    .insert(schema.indexerState)
    .values({
      id: "canonical",
      chainId: block.chainId,
      blockRetention: options.blockRetention,
      ...head,
    })
    .onConflictDoUpdate((row) => {
      if (row.blockRetention !== options.blockRetention)
        throw new Error("INDEXER_BLOCK_RETENTION changed: rebuild into a fresh schema");
      return head;
    });
}

interface ProtocolLogEvent {
  args: unknown;
  block: {
    hash: Hex;
    number: bigint;
    timestamp: bigint;
  };
  id: string;
  log: {
    address: Address;
    logIndex: number;
  };
  transaction: {
    from: Address;
    hash: Hex;
    nonce: number;
    to: Address | null;
    transactionIndex: number;
    value: bigint;
  };
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
export const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;
export const quoteUp = quoteForReservation;

export const persistProtocolEvent = async (
  db: AppDb,
  chainId: number,
  _contractName: string,
  _eventName: string,
  event: ProtocolLogEvent,
): Promise<boolean> => {
  const inserted = await db
    .insert(chainEvent)
    .values({
      id: event.id,
    })
    .onConflictDoNothing();

  if (inserted === null) return false;

  await db
    .insert(chainTransaction)
    .values({
      hash: event.transaction.hash,
      blockHash: event.block.hash,
      blockNumber: event.block.number,
      chainId: BigInt(chainId),
      from: event.transaction.from,
      nonce: BigInt(event.transaction.nonce),
      status: "success",
      to: event.transaction.to,
      transactionIndex: event.transaction.transactionIndex,
      value: event.transaction.value,
    })
    .onConflictDoNothing();
  return true;
};

export const balanceKey = (account: Address, asset: Address, tokenId?: bigint): string =>
  `${account.toLowerCase()}:${asset.toLowerCase()}:${tokenId?.toString() ?? "erc20"}`;

export const walletMarketKey = (marketId: Hex, account: Address): string =>
  `${marketId.toLowerCase()}:${account.toLowerCase()}`;

export async function adjustPayoutCredit(
  db: IndexerWriter,
  input: {
    beneficiary: Address;
    asset: Address;
    tokenId: bigint;
    delta: bigint;
    blockNumber: bigint;
  },
) {
  const { tokenId, delta, blockNumber } = input;
  if (delta === 0n || tokenId < 0n || tokenId >= 1n << 256n)
    throw new Error("Invalid payout credit change");
  const beneficiary = input.beneficiary.toLowerCase() as Address;
  const asset = input.asset.toLowerCase() as Address;
  const id = balanceKey(beneficiary, asset, tokenId);
  const before = await db.find(schema.payoutCredit, { id });
  const amount = (before?.amount ?? 0n) + delta;
  if (amount < 0n || amount >= 1n << 256n) throw new Error(`Invalid payout liability for ${id}`);
  if (amount === 0n) {
    await db.delete(schema.payoutCredit, { id });
    return;
  }
  if (before)
    await db.update(schema.payoutCredit, { id }).set({ amount, updatedBlock: blockNumber });
  else
    await db
      .insert(schema.payoutCredit)
      .values({ id, beneficiary, asset, tokenId, amount, updatedBlock: blockNumber });
}

export const updateClaimBalance = async (
  db: AppDb,
  account: Address,
  positionId: bigint,
  delta: bigint,
  blockNumber: bigint,
): Promise<void> => {
  if (account.toLowerCase() === ZERO_ADDRESS) return;
  const id = balanceKey(account, ZERO_ADDRESS, positionId);
  await db
    .insert(schema.claimBalance)
    .values({ id, account, amount: delta, positionId, updatedBlock: blockNumber })
    .onConflictDoUpdate((row) => {
      const amount = row.amount + delta;
      if (amount < 0n) throw new Error(`negative claim balance for ${id}`);
      return { amount, updatedBlock: blockNumber };
    });
};

export const updateMarketInterest = async (
  db: Parameters<typeof persistProtocolEvent>[0],
  marketId: Hex,
  delta: bigint,
  blockNumber: bigint,
): Promise<void> => {
  await db
    .insert(schema.marketOpenInterest)
    .values({ marketId, amount: delta, updatedBlock: blockNumber })
    .onConflictDoUpdate((row) => {
      const amount = row.amount + delta;
      if (amount < 0n) throw new Error(`negative market open interest for ${marketId}`);
      return { amount, updatedBlock: blockNumber };
    });
};

export const updateWalletInterest = async (
  db: Parameters<typeof persistProtocolEvent>[0],
  marketId: Hex,
  account: Address,
  delta: bigint,
  blockNumber: bigint,
): Promise<void> => {
  const id = walletMarketKey(marketId, account);
  await db
    .insert(schema.walletOpenInterest)
    .values({ id, account, amount: delta, marketId, updatedBlock: blockNumber })
    .onConflictDoUpdate((row) => {
      const amount = row.amount + delta;
      if (amount < 0n) throw new Error(`negative wallet open interest for ${id}`);
      return { amount, updatedBlock: blockNumber };
    });
};
