import { and, asc, desc, eq, gt, gte, lt, lte, ne, type ReadonlyDrizzle, sql } from "ponder";
import type { Address, Hex } from "viem";
import * as schema from "./schema.ts";
import { readReconciliationSnapshot } from "./snapshot.ts";

/** Inject Ponder's read-only connection; do not create an independent pool or bypass finality. */
export function createIndexerQueries(db: ReadonlyDrizzle<typeof schema>) {
  const readRawState = () =>
    db.query.indexerState.findFirst({ where: eq(schema.indexerState.id, "canonical") });
  const canonicalBlock = (number: bigint) =>
    db.query.chainBlock.findFirst({ where: eq(schema.chainBlock.number, number) });
  const marketById = (id: Hex) => db.query.market.findFirst({ where: eq(schema.market.id, id) });
  const orderByHash = (id: Hex) => db.query.order.findFirst({ where: eq(schema.order.id, id) });
  const transactionByHash = (hash: Hex) =>
    db.query.chainTransaction.findFirst({ where: eq(schema.chainTransaction.hash, hash) });
  const resolutionByMarket = (marketId: Hex) =>
    db.query.resolution.findFirst({ where: eq(schema.resolution.marketId, marketId) });
  const protocolState = () =>
    db.query.protocolState.findFirst({ where: eq(schema.protocolState.id, "v1") });
  const markets = () => db.select().from(schema.market).orderBy(desc(schema.market.createdBlock));
  const claims = (account: Address) =>
    db.select().from(schema.claimBalance).where(eq(schema.claimBalance.account, account));
  const payoutCredits = (account: Address, after?: string) =>
    db
      .select()
      .from(schema.payoutCredit)
      .where(
        and(
          eq(schema.payoutCredit.beneficiary, account),
          after ? gt(schema.payoutCredit.id, after) : undefined,
        ),
      )
      .orderBy(asc(schema.payoutCredit.id))
      .limit(101);

  function orderbook(marketId: Hex, limit: number) {
    return db
      .select()
      .from(schema.order)
      .where(and(eq(schema.order.marketId, marketId), eq(schema.order.status, "open")))
      .orderBy(
        asc(schema.order.branch),
        asc(schema.order.side),
        desc(schema.order.limitPriceRawX18),
        asc(schema.order.sequence),
      )
      .limit(limit);
  }

  function orders(input: {
    maker: Address | null;
    marketId: Hex | null;
    status: string | undefined;
    limit: number;
  }) {
    return db
      .select()
      .from(schema.order)
      .where(
        and(
          input.maker ? eq(schema.order.maker, input.maker) : undefined,
          input.marketId ? eq(schema.order.marketId, input.marketId) : undefined,
          input.status ? eq(schema.order.status, input.status) : undefined,
        ),
      )
      .orderBy(desc(schema.order.updatedBlock), desc(schema.order.sequence))
      .limit(input.limit);
  }

  function trades(marketId: Hex | null, limit: number) {
    return db
      .select()
      .from(schema.fill)
      .where(marketId ? eq(schema.fill.marketId, marketId) : undefined)
      .orderBy(desc(schema.fill.blockNumber), desc(schema.fill.logIndex))
      .limit(limit);
  }

  function reservations() {
    return db
      .select()
      .from(schema.reservation)
      .where(gt(schema.reservation.amount, 0n))
      .orderBy(asc(schema.reservation.assetAddress), asc(schema.reservation.tokenId));
  }

  function matchCandidates(input: {
    marketId: Hex;
    branch: number;
    side: number;
    limitPriceRawX18: bigint;
    makerFeeBps: number;
    confirmedThrough: bigint;
    timestamp: bigint;
  }) {
    return db
      .select()
      .from(schema.order)
      .where(
        and(
          eq(schema.order.marketId, input.marketId),
          eq(schema.order.branch, input.branch),
          eq(schema.order.side, input.side),
          eq(schema.order.status, "open"),
          eq(schema.order.timeInForce, 0),
          lte(schema.order.updatedBlock, input.confirmedThrough),
          gt(schema.order.expiry, input.timestamp),
          gt(schema.order.remaining, 0n),
          gte(schema.order.maxFeeBps, input.makerFeeBps),
          sql`not exists (select 1 from ${schema.nonceFloor} where ${schema.nonceFloor.maker} = ${schema.order.maker} and ${schema.nonceFloor.minimumNonce} > ${schema.order.nonce})`,
          input.side === 0
            ? gte(schema.order.limitPriceRawX18, input.limitPriceRawX18)
            : lte(schema.order.limitPriceRawX18, input.limitPriceRawX18),
        ),
      )
      .orderBy(
        input.side === 0 ? desc(schema.order.limitPriceRawX18) : asc(schema.order.limitPriceRawX18),
        asc(schema.order.sequence),
      )
      .limit(33);
  }

  async function reconciliationSnapshot(deep: boolean) {
    return readReconciliationSnapshot(db, deep);
  }

  async function staleReservations(input: {
    marketId: Hex;
    maker: Address;
    confirmedThrough: bigint;
    timestamp: bigint;
  }) {
    const fields = {
      orderHash: schema.order.id,
      maker: schema.order.maker,
      marketId: schema.order.marketId,
      openNotional: schema.order.openNotional,
      expiry: schema.order.expiry,
      sequence: schema.order.sequence,
    };
    // Separate expiry and nonce paths keep their selective indexes usable. Each query is
    // bounded; own-wallet stale escrow takes priority when both wallet and market caps bind.
    const rows = (
      await Promise.all(
        [true, false].flatMap((own) => {
          const common = and(
            eq(schema.order.marketId, input.marketId),
            eq(schema.order.status, "open"),
            own ? eq(schema.order.maker, input.maker) : ne(schema.order.maker, input.maker),
            lte(schema.order.updatedBlock, input.confirmedThrough),
            gt(schema.order.openNotional, 0n),
          );
          return [
            db
              .select(fields)
              .from(schema.order)
              .where(and(common, lte(schema.order.expiry, input.timestamp)))
              .orderBy(asc(schema.order.expiry), asc(schema.order.sequence))
              .limit(33),
            db
              .select(fields)
              .from(schema.order)
              .innerJoin(
                schema.nonceFloor,
                and(
                  eq(schema.nonceFloor.maker, schema.order.maker),
                  lt(schema.order.nonce, schema.nonceFloor.minimumNonce),
                ),
              )
              .where(common)
              .orderBy(asc(schema.order.maker), asc(schema.order.nonce), asc(schema.order.sequence))
              .limit(33),
          ];
        }),
      )
    ).flat();
    const unique = [...new Map(rows.map((row) => [row.orderHash, row])).values()];
    unique.sort((a, b) => {
      const own = Number(b.maker === input.maker) - Number(a.maker === input.maker);
      return (
        own ||
        (a.expiry === b.expiry ? (a.sequence < b.sequence ? -1 : 1) : a.expiry < b.expiry ? -1 : 1)
      );
    });
    return unique.slice(0, 33);
  }

  return {
    readRawState,
    canonicalBlock,
    marketById,
    orderByHash,
    transactionByHash,
    resolutionByMarket,
    protocolState,
    markets,
    claims,
    payoutCredits,
    orderbook,
    orders,
    trades,
    reservations,
    matchCandidates,
    staleReservations,
    reconciliationSnapshot,
  };
}

export type IndexerQueries = ReturnType<typeof createIndexerQueries>;
