import { index, onchainTable, sql } from "ponder";

export const chainBlock = onchainTable(
  "chain_block",
  (table) => ({
    // Fixed-size, reorg-aware ring. Overwrites go through Ponder's undo journal.
    slot: table.integer().primaryKey(),
    number: table.bigint().notNull(),
    chainId: table.bigint().notNull(),
    hash: table.hex().notNull(),
    parentHash: table.hex().notNull(),
    timestamp: table.bigint().notNull(),
  }),
  (table) => ({ numberIdx: index("chain_block_number_idx").on(table.number) }),
);

export const indexerState = onchainTable("indexer_state", (table) => ({
  id: table.text().primaryKey(),
  chainId: table.bigint().notNull(),
  indexedBlock: table.bigint().notNull(),
  blockRetention: table.integer().notNull(),
  indexedBlockHash: table.hex().notNull(),
  indexedBlockTimestamp: table.bigint().notNull(),
  confirmedBlock: table.bigint().notNull(),
  finalizedBlock: table.bigint().notNull(),
}));

export const chainTransaction = onchainTable(
  "chain_transaction",
  (table) => ({
    hash: table.hex().primaryKey(),
    chainId: table.bigint().notNull(),
    blockNumber: table.bigint().notNull(),
    blockHash: table.hex().notNull(),
    transactionIndex: table.integer().notNull(),
    from: table.hex().notNull(),
    to: table.hex(),
    nonce: table.bigint().notNull(),
    value: table.bigint().notNull(),
    status: table.text().notNull(),
  }),
  (table) => ({ blockIdx: index("chain_transaction_block_idx").on(table.blockNumber) }),
);

// Only the delivery guard is consumed. Raw log bodies already live in Ponder's replay cache.
export const chainEvent = onchainTable("chain_event", (table) => ({
  id: table.text().primaryKey(),
}));

export const market = onchainTable(
  "market",
  (table) => ({
    id: table.hex().primaryKey(),
    baseToken: table.hex().notNull(),
    quoteToken: table.hex().notNull(),
    baseTokenDecimals: table.integer().notNull(),
    quoteTokenDecimals: table.integer().notNull(),
    protocolVersion: table.integer().notNull(),
    priceFormat: table.text().notNull(),
    localQuestionId: table.hex().notNull(),
    conditionId: table.hex().notNull(),
    polymarketConditionId: table.hex().notNull(),
    rulesHash: table.hex().notNull(),
    metadataHash: table.hex().notNull(),
    metadataUri: table.text().notNull(),
    polymarketYesIndex: table.bigint(),
    polymarketNoIndex: table.bigint(),
    stockYesPositionId: table.bigint(),
    stockNoPositionId: table.bigint(),
    quoteYesPositionId: table.bigint(),
    quoteNoPositionId: table.bigint(),
    tradingOpen: table.bigint(),
    tradingCutoff: table.bigint(),
    priceTickRawX18: table.bigint(),
    baseStep: table.bigint(),
    minNotional: table.bigint(),
    maxOrderQuantity: table.bigint(),
    maxOrderNotional: table.bigint(),
    maxWalletOpenNotional: table.bigint(),
    maxMarketOpenNotional: table.bigint(),
    state: table.integer().notNull(),
    stateReasonHash: table.hex().notNull(),
    createdBlock: table.bigint().notNull(),
    updatedBlock: table.bigint().notNull(),
  }),
  (table) => ({
    createdIdx: index("market_created_idx").on(table.createdBlock.desc().nullsFirst()),
  }),
);

export const order = onchainTable(
  "protocol_order",
  (table) => ({
    id: table.hex().primaryKey(),
    marketId: table.hex().notNull(),
    maker: table.hex().notNull(),
    recipient: table.hex().notNull(),
    branch: table.integer().notNull(),
    side: table.integer().notNull(),
    fundingKind: table.integer().notNull(),
    timeInForce: table.integer().notNull(),
    quantity: table.bigint().notNull(),
    // Executed base units, preserved when cancellation clears the live remainder.
    filled: table.bigint().notNull(),
    limitPriceRawX18: table.bigint().notNull(),
    maxFeeBps: table.integer().notNull(),
    // Raw received-asset claims charged across this order's fills; no duplicate fee ledger.
    feesPaid: table.bigint().notNull(),
    expiry: table.bigint().notNull(),
    nonce: table.bigint().notNull(),
    salt: table.hex().notNull(),
    sequence: table.bigint().notNull(),
    initialReserved: table.bigint().notNull(),
    reserved: table.bigint().notNull(),
    remaining: table.bigint().notNull(),
    openNotional: table.bigint().notNull(),
    status: table.text().notNull(),
    cancelReasonHash: table.hex(),
    openedBlock: table.bigint().notNull(),
    updatedBlock: table.bigint().notNull(),
  }),
  (table) => ({
    bookIdx: index("order_book_idx")
      .on(
        table.marketId,
        table.branch,
        table.side,
        table.limitPriceRawX18.desc().nullsFirst(),
        table.sequence,
      )
      .where(sql`${table.status} = 'open'`),
    // An ascending scan is not interchangeable with price DESC / FIFO ASC.
    askIdx: index("order_ask_idx")
      .on(table.marketId, table.branch, table.side, table.limitPriceRawX18, table.sequence)
      .where(sql`${table.status} = 'open'`),
    expiryIdx: index("order_open_expiry_idx")
      .on(table.marketId, table.expiry, table.sequence)
      .where(sql`${table.status} = 'open'`),
    nonceIdx: index("order_open_maker_nonce_idx")
      .on(table.marketId, table.maker, table.nonce, table.sequence)
      .where(sql`${table.status} = 'open'`),
    walletExpiryIdx: index("order_open_wallet_expiry_idx")
      .on(table.marketId, table.maker, table.expiry, table.sequence)
      .where(sql`${table.status} = 'open'`),
    makerIdx: index("order_maker_history_idx").on(
      table.maker,
      table.updatedBlock.desc().nullsFirst(),
      table.sequence.desc().nullsFirst(),
    ),
    marketHistoryIdx: index("order_market_history_idx").on(
      table.marketId,
      table.updatedBlock.desc().nullsFirst(),
      table.sequence.desc().nullsFirst(),
    ),
  }),
);

export const reservation = onchainTable(
  "reservation",
  (table) => ({
    orderHash: table.hex().primaryKey(),
    marketId: table.hex().notNull(),
    maker: table.hex().notNull(),
    assetAddress: table.hex().notNull(),
    tokenId: table.bigint(),
    amount: table.bigint().notNull(),
    fundingKind: table.integer().notNull(),
    updatedBlock: table.bigint().notNull(),
  }),
  (table) => ({
    assetIdx: index("reservation_active_asset_idx")
      .on(table.assetAddress, table.tokenId)
      .where(sql`${table.amount} > 0`),
  }),
);

export const marketOpenInterest = onchainTable("market_open_interest", (table) => ({
  marketId: table.hex().primaryKey(),
  amount: table.bigint().notNull(),
  updatedBlock: table.bigint().notNull(),
}));

export const walletOpenInterest = onchainTable("wallet_open_interest", (table) => ({
  id: table.text().primaryKey(),
  marketId: table.hex().notNull(),
  account: table.hex().notNull(),
  amount: table.bigint().notNull(),
  updatedBlock: table.bigint().notNull(),
}));

export const fill = onchainTable(
  "fill",
  (table) => ({
    id: table.text().primaryKey(),
    buyOrderHash: table.hex().notNull(),
    sellOrderHash: table.hex().notNull(),
    marketId: table.hex().notNull(),
    branch: table.integer().notNull(),
    fillQuantity: table.bigint().notNull(),
    executionPriceRawX18: table.bigint().notNull(),
    executionQuote: table.bigint().notNull(),
    makerOrderHash: table.hex().notNull(),
    blockNumber: table.bigint().notNull(),
    blockTimestamp: table.bigint().notNull(),
    transactionHash: table.hex().notNull(),
    logIndex: table.integer().notNull(),
  }),
  (table) => ({
    marketIdx: index("fill_market_idx").on(
      table.marketId,
      table.blockNumber.desc().nullsFirst(),
      table.logIndex.desc().nullsFirst(),
    ),
    recentIdx: index("fill_recent_idx").on(
      table.blockNumber.desc().nullsFirst(),
      table.logIndex.desc().nullsFirst(),
    ),
    transactionIdx: index("fill_transaction_idx").on(
      table.transactionHash,
      table.blockNumber,
      table.logIndex,
    ),
  }),
);

export const claimBalance = onchainTable(
  "claim_balance",
  (table) => ({
    id: table.text().primaryKey(),
    account: table.hex().notNull(),
    positionId: table.bigint().notNull(),
    amount: table.bigint().notNull(),
    updatedBlock: table.bigint().notNull(),
  }),
  (table) => ({
    accountIdx: index("claim_balance_account_idx").on(table.account, table.positionId),
    supplyIdx: index("claim_balance_supply_idx")
      .on(table.positionId)
      .where(sql`${table.amount} > 0`),
  }),
);

export const nonceFloor = onchainTable("nonce_floor", (table) => ({
  maker: table.hex().primaryKey(),
  minimumNonce: table.bigint().notNull(),
  updatedBlock: table.bigint().notNull(),
}));

// Only outstanding, beneficiary-owned failed payouts. Successful payouts create no rows;
// fully claimed credits are deleted through Ponder's reversible block journal.
export const payoutCredit = onchainTable(
  "payout_credit",
  (table) => ({
    id: table.text().primaryKey(),
    beneficiary: table.hex().notNull(),
    asset: table.hex().notNull(),
    tokenId: table.bigint().notNull(),
    amount: table.bigint().notNull(),
    updatedBlock: table.bigint().notNull(),
  }),
  (table) => ({
    beneficiaryIdx: index("payout_credit_beneficiary_idx").on(table.beneficiary, table.id),
  }),
);

export const protocolState = onchainTable("protocol_state", (table) => ({
  id: table.text().primaryKey(),
  tradingPaused: table.boolean().notNull(),
  pauseReasonHash: table.hex().notNull(),
  pauseCaller: table.hex().notNull(),
  updatedBlock: table.bigint().notNull(),
}));

export const resolution = onchainTable("resolution", (table) => ({
  marketId: table.hex().primaryKey(),
  conditionId: table.hex().notNull(),
  admin: table.hex().notNull(),
  yesPayout: table.bigint().notNull(),
  noPayout: table.bigint().notNull(),
  payoutDenominator: table.bigint().notNull(),
  evidenceHash: table.hex().notNull(),
  evidenceUri: table.text().notNull(),
  finalizedAt: table.bigint().notNull(),
  blockNumber: table.bigint().notNull(),
  transactionHash: table.hex().notNull(),
}));
