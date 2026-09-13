import { db, publicClients } from "ponder:api";
import { createIndexerQueries } from "@conditional-stocks/db/indexer/reads";
import type * as schema from "@conditional-stocks/db/indexer/schema";
import { tokenDecimals } from "@conditional-stocks/domain";
import { requestLogging } from "@conditional-stocks/shared/http";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { type Address, erc20Abi, type Hex, isAddress, isHex } from "viem";
import { indexerEnvironment } from "../../ponder.config.ts";
import {
  CanonicalBlockReorged,
  CanonicalBlockUnavailable,
  createCanonicalBlockReader,
} from "../canonical-block.ts";
import { logger } from "../logger.ts";
import { verifiedHead } from "../verified-head.ts";

const app = new Hono();
app.use(
  "*",
  requestLogging(logger, {
    quietPaths: [
      "/indexer/health",
      "/internal/canonical-block/:number",
      "/internal/reconciliation-snapshot",
    ],
  }),
);

const queries = createIndexerQueries(db);
const canonicalBlock = createCanonicalBlockReader(
  queries,
  publicClients.robinhood,
  indexerEnvironment.chainId,
);
const readRawState = queries.readRawState;
const readState = async () => {
  const state = await readRawState();
  try {
    return state
      ? await verifiedHead(state, publicClients.robinhood, indexerEnvironment)
      : undefined;
  } catch {
    throw new HTTPException(503, {
      message: "canonical indexer head unavailable, stale or reorganized",
    });
  }
};

const json = (value: unknown, status = 200): Response =>
  new Response(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item,
    ),
    {
      headers: { "content-type": "application/json; charset=utf-8" },
      status,
    },
  );

const parseBigIntParameter = (value: string | undefined, fallback: bigint): bigint => {
  if (value === undefined) return fallback;
  if (!/^(0|[1-9][0-9]{0,77})$/.test(value)) throw new Error("invalid non-negative integer");
  return BigInt(value);
};

const parseIntParameter = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("invalid non-negative integer");
  return parsed;
};

const parseHash = (value: string): Hex | null =>
  isHex(value) && value.length === 66 ? (value.toLowerCase() as Hex) : null;

const canonicalAddress = (value: string): Address => value.toLowerCase() as Address;

const confirmationState = (
  blockNumber: bigint,
  state: typeof schema.indexerState.$inferSelect,
): "observed" | "confirmed" | "finalized" => {
  if (blockNumber <= state.finalizedBlock) return "finalized";
  if (blockNumber <= state.confirmedBlock) return "confirmed";
  return "observed";
};

app.onError((error) =>
  json(
    { error: error.message },
    error instanceof HTTPException
      ? error.status
      : error instanceof CanonicalBlockUnavailable
        ? 503
        : error instanceof CanonicalBlockReorged
          ? 503
          : 400,
  ),
);

app.get("/", (context) =>
  context.json({
    chainId: indexerEnvironment.chainId,
    name: "conditional-stocks-rh-indexer",
    runtime: "ponder",
    version: 2,
  }),
);

app.get("/indexer/health", async () => {
  let state: Awaited<ReturnType<typeof readState>>;
  try {
    state = await readState();
  } catch (error) {
    return json(
      { healthy: false, reason: error instanceof Error ? error.message : "head-unavailable" },
      503,
    );
  }
  if (!state) {
    return json({ healthy: false, reason: "not-indexed" }, 503);
  }
  const now = BigInt(Math.floor(Date.now() / 1000));
  const ageSeconds = now > state.indexedBlockTimestamp ? now - state.indexedBlockTimestamp : 0n;
  return json({
    chainId: indexerEnvironment.chainId,
    exchange: indexerEnvironment.contracts.exchange,
    finalityMode: indexerEnvironment.finalityMode,
    confirmationMode: indexerEnvironment.confirmationMode,
    confirmationBlockCount: indexerEnvironment.confirmationBlockCount,
    finalityBlockCount: indexerEnvironment.finalityBlockCount,
    head: state,
    headAgeSeconds: ageSeconds,
    healthy: true,
    protocolVersion: 2,
    priceFormat: "raw-unit-ratio-x18",
  });
});

app.get("/markets", async () => {
  const rows = await queries.markets();
  return json({ markets: rows });
});

app.get("/internal/canonical-block/:number", async (context) => {
  const blockNumber = parseBigIntParameter(context.req.param("number"), 0n);
  const state = await readState();
  if (!state || blockNumber > state.indexedBlock) return json({ error: "block-not-indexed" }, 503);
  const row = await canonicalBlock(blockNumber, state, true);
  return json(row);
});

app.get("/markets/:marketId", async (context) => {
  const marketId = parseHash(context.req.param("marketId"));
  if (!marketId) return json({ error: "invalid-market-id" }, 400);
  const row = await queries.marketById(marketId);
  return row ? json(row) : json({ error: "market-not-found" }, 404);
});

app.get("/orderbook/:marketId", async (context) => {
  const marketId = parseHash(context.req.param("marketId"));
  if (!marketId) return json({ error: "invalid-market-id" }, 400);
  const requestedLimit = parseIntParameter(context.req.query("limit"), 500);
  const limit = Math.min(Math.max(requestedLimit, 1), 2_000);
  const rows = await queries.orderbook(marketId, limit);
  return json({ marketId, orders: rows, truncated: rows.length === limit });
});

app.get("/orders", async (context) => {
  const makerInput = context.req.query("maker");
  const marketIdInput = context.req.query("marketId");
  if (!makerInput && !marketIdInput) {
    return json({ error: "maker or marketId is required" }, 400);
  }
  if (makerInput && !isAddress(makerInput)) return json({ error: "invalid-maker" }, 400);
  const marketId = marketIdInput ? parseHash(marketIdInput) : null;
  if (marketIdInput && !marketId) return json({ error: "invalid-market-id" }, 400);
  const status = context.req.query("status");
  const requestedLimit = parseIntParameter(context.req.query("limit"), 250);
  const limit = Math.min(Math.max(requestedLimit, 1), 1_000);
  const rows = await queries.orders({
    maker: makerInput ? canonicalAddress(makerInput) : null,
    marketId,
    status,
    limit,
  });
  const state = await readState();
  return json({
    orders: rows.map((row) => ({
      ...row,
      confirmation: state ? confirmationState(row.updatedBlock, state) : "observed",
    })),
    truncated: rows.length === limit,
  });
});

app.get("/orders/:orderHash", async (context) => {
  const orderHash = parseHash(context.req.param("orderHash"));
  if (!orderHash) return json({ error: "invalid-order-hash" }, 400);
  const row = await queries.orderByHash(orderHash);
  if (!row) return json({ error: "order-not-found" }, 404);
  const state = await readState();
  return json({
    ...row,
    confirmation: state ? confirmationState(row.updatedBlock, state) : "observed",
  });
});

app.get("/trades", async (context) => {
  const marketIdInput = context.req.query("marketId");
  const marketId = marketIdInput ? parseHash(marketIdInput) : null;
  if (marketIdInput && !marketId) return json({ error: "invalid-market-id" }, 400);
  const limit = Math.min(Math.max(parseIntParameter(context.req.query("limit"), 100), 1), 1_000);
  const rows = await queries.trades(marketId, limit);
  return json({ trades: rows });
});

app.get("/transactions/:transactionHash", async (context) => {
  const transactionHash = parseHash(context.req.param("transactionHash"));
  if (!transactionHash) return json({ error: "invalid-transaction-hash" }, 400);
  const transaction = await queries.transactionByHash(transactionHash);
  if (!transaction) return json({ error: "transaction-not-found" }, 404);
  const state = await readState();
  return json({
    ...transaction,
    confirmation: state ? confirmationState(transaction.blockNumber, state) : "observed",
  });
});

app.get("/balances/:account", async (context) => {
  const input = context.req.param("account");
  if (!isAddress(input)) return json({ error: "invalid-account" }, 400);
  const account = canonicalAddress(input);
  const tokenInput = context.req.query("token");
  if (!tokenInput) {
    return json({
      claims: await queries.claims(account),
      note: "ERC-20 transfer deltas are not tracked; pass ?token=0x… for canonical balanceOf",
      wholeTokenDeltas: null,
    });
  }
  if (!isAddress(tokenInput)) return json({ error: "invalid-token" }, 400);
  const [claims, state] = await Promise.all([queries.claims(account), readState()]);
  if (!state) return json({ error: "indexer-not-ready" }, 503);
  const token = canonicalAddress(tokenInput);
  const canonicalBalance = await publicClients.robinhood.readContract({
    abi: erc20Abi,
    address: token,
    args: [account],
    blockNumber: state.indexedBlock,
    functionName: "balanceOf",
  });
  const decimals = tokenDecimals(
    await publicClients.robinhood.readContract({
      abi: erc20Abi,
      address: token,
      functionName: "decimals",
      blockNumber: state.indexedBlock,
    }),
  );
  return json({
    account,
    decimals,
    blockNumber: state.indexedBlock,
    canonicalBalance,
    claims,
    token,
    wholeTokenDelta: null,
  });
});

app.get("/positions/:account", async (context) => {
  const input = context.req.param("account");
  if (!isAddress(input)) return json({ error: "invalid-account" }, 400);
  const account = canonicalAddress(input);
  const [claims, markets] = await Promise.all([queries.claims(account), queries.markets()]);
  const balances = new Map(claims.map((claim) => [claim.positionId.toString(), claim.amount]));
  return json({
    account,
    positions: markets.map((row) => ({
      baseTokenDecimals: row.baseTokenDecimals,
      quoteTokenDecimals: row.quoteTokenDecimals,
      protocolVersion: row.protocolVersion,
      priceFormat: row.priceFormat,
      conditionId: row.conditionId,
      marketId: row.id,
      quoteNo: row.quoteNoPositionId ? (balances.get(row.quoteNoPositionId.toString()) ?? 0n) : 0n,
      quoteYes: row.quoteYesPositionId
        ? (balances.get(row.quoteYesPositionId.toString()) ?? 0n)
        : 0n,
      redeemable: row.state >= 6,
      stockNo: row.stockNoPositionId ? (balances.get(row.stockNoPositionId.toString()) ?? 0n) : 0n,
      stockYes: row.stockYesPositionId
        ? (balances.get(row.stockYesPositionId.toString()) ?? 0n)
        : 0n,
    })),
  });
});

app.get("/payouts/:account", async (context) => {
  const rawAccount = context.req.param("account");
  if (!isAddress(rawAccount)) return json({ error: "invalid-account" }, 400);
  const account = canonicalAddress(rawAccount);
  const after = context.req.query("after");
  if (
    after &&
    (!/^0x[0-9a-f]{40}:0x[0-9a-f]{40}:(0|[1-9][0-9]{0,77})$/.test(after) ||
      !after.startsWith(`${account}:`))
  )
    return json({ error: "invalid-cursor" }, 400);
  const [state, rows] = await Promise.all([readState(), queries.payoutCredits(account, after)]);
  if (!state) return json({ error: "indexer-not-ready" }, 503);
  const marketRows = rows.length ? await queries.markets() : [];
  const metadata = new Map<
    string,
    {
      collateralToken: Address;
      decimals: number;
      branch: "YES" | "NO" | null;
      kind: "stock" | "quote";
      marketId: Hex | null;
    }
  >();
  const ctf = indexerEnvironment.contracts.conditionalTokens.toLowerCase();
  for (const market of marketRows) {
    for (const [kind, token, decimals, yes, no] of [
      [
        "stock",
        market.baseToken,
        market.baseTokenDecimals,
        market.stockYesPositionId,
        market.stockNoPositionId,
      ],
      [
        "quote",
        market.quoteToken,
        market.quoteTokenDecimals,
        market.quoteYesPositionId,
        market.quoteNoPositionId,
      ],
    ] as const) {
      metadata.set(`${token.toLowerCase()}:0`, {
        collateralToken: token,
        decimals,
        branch: null,
        kind,
        marketId: null,
      });
      for (const [branch, id] of [
        ["YES", yes],
        ["NO", no],
      ] as const) {
        if (id !== null)
          metadata.set(`${ctf}:${id}`, {
            collateralToken: token,
            decimals,
            branch,
            kind,
            marketId: market.id,
          });
      }
    }
  }
  const page = rows.slice(0, 100);
  return json({
    account,
    vault: indexerEnvironment.contracts.payoutVault,
    nextCursor: rows.length > 100 ? page.at(-1)?.id : null,
    payouts: page.map((row) => {
      const display = metadata.get(`${row.asset.toLowerCase()}:${row.tokenId}`);
      if (!display) throw new HTTPException(503, { message: "payout token metadata unavailable" });
      return { ...row, ...display, confirmation: confirmationState(row.updatedBlock, state) };
    }),
  });
});

app.get("/resolutions/:marketId", async (context) => {
  const marketId = parseHash(context.req.param("marketId"));
  if (!marketId) return json({ error: "invalid-market-id" }, 400);
  const row = await queries.resolutionByMarket(marketId);
  return row ? json(row) : json({ error: "resolution-not-found" }, 404);
});

app.get("/internal/reservations", async () => {
  const rows = await queries.reservations();
  return json({ reservations: rows });
});

app.get("/internal/match-candidates", async (context) => {
  const marketId = parseHash(context.req.query("marketId") ?? "");
  const branch = parseIntParameter(context.req.query("branch"), 2);
  const side = parseIntParameter(context.req.query("side"), 2);
  const makerFeeBps = parseIntParameter(context.req.query("makerFeeBps"), 1001);
  const timestamp = parseBigIntParameter(context.req.query("timestamp"), 0n);
  const limitPriceRawX18 = parseBigIntParameter(context.req.query("limitPriceRawX18"), 0n);
  const atBlock = parseBigIntParameter(context.req.query("atBlock"), 0n);
  if (
    !marketId ||
    branch > 1 ||
    side > 1 ||
    makerFeeBps > 1000 ||
    limitPriceRawX18 <= 0n ||
    limitPriceRawX18 >= 1n << 128n ||
    timestamp <= 0n ||
    timestamp >= 1n << 64n
  )
    return json({ error: "invalid-match-query" }, 400);
  const state = await readState();
  if (!state || atBlock > state.confirmedBlock) return json({ error: "unconfirmed-book" }, 503);
  const anchor = await canonicalBlock(atBlock, state);
  if (timestamp < anchor.timestamp) return json({ error: "timestamp-before-anchor" }, 400);
  const rows = await queries.matchCandidates({
    marketId,
    branch,
    side,
    makerFeeBps,
    limitPriceRawX18,
    confirmedThrough: atBlock,
    timestamp,
  });
  return json({
    chainId: indexerEnvironment.chainId,
    exchange: indexerEnvironment.contracts.exchange,
    blockNumber: anchor.number,
    blockHash: anchor.hash,
    candidates: rows.map((row) => ({
      orderHash: row.id,
      remaining: row.remaining,
      sequence: row.sequence,
      order: {
        marketId: row.marketId,
        maker: row.maker,
        recipient: row.recipient,
        branch: row.branch,
        side: row.side,
        fundingKind: row.fundingKind,
        tif: row.timeInForce,
        quantity: row.quantity,
        limitPriceRawX18: row.limitPriceRawX18,
        nonce: row.nonce,
        salt: row.salt,
        maxFeeBps: row.maxFeeBps,
        expiry: row.expiry,
      },
    })),
  });
});

app.get("/internal/stale-reservations", async (context) => {
  const marketId = parseHash(context.req.query("marketId") ?? "");
  const maker = context.req.query("maker") ?? "";
  const timestamp = parseBigIntParameter(context.req.query("timestamp"), 0n);
  const atBlock = parseBigIntParameter(context.req.query("atBlock"), 0n);
  if (!marketId || !isAddress(maker) || timestamp <= 0n || timestamp >= 1n << 64n)
    return json({ error: "invalid-recovery-query" }, 400);
  const state = await readState();
  if (!state || atBlock > state.confirmedBlock) return json({ error: "unconfirmed-book" }, 503);
  const anchor = await canonicalBlock(atBlock, state);
  if (timestamp < anchor.timestamp) return json({ error: "timestamp-before-anchor" }, 400);
  const candidates = await queries.staleReservations({
    marketId,
    maker: canonicalAddress(maker),
    confirmedThrough: atBlock,
    timestamp,
  });
  return json({
    chainId: indexerEnvironment.chainId,
    exchange: indexerEnvironment.contracts.exchange,
    blockNumber: anchor.number,
    blockHash: anchor.hash,
    candidates,
  });
});

app.get("/internal/reconciliation-snapshot", async (context) => {
  const deep = context.req.query("deep") === "true";
  const snapshot = await queries.reconciliationSnapshot(deep).catch(() => {
    throw new HTTPException(503, { message: "consistent projection snapshot unavailable; retry" });
  });
  const state = await verifiedHead(snapshot.head, publicClients.robinhood, indexerEnvironment);
  return json({ ...snapshot.rows, state });
});

export default app;
