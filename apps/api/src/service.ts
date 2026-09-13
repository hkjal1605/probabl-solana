import { randomBytes } from "node:crypto";
import type { TradingSafety } from "@conditional-stocks/config";
import {
  type GatewayQueries,
  type OperationKind,
  OperationLeaseUnavailable,
  type OperationRecord,
} from "@conditional-stocks/db/gateway";
import type { Order } from "@conditional-stocks/domain";
import {
  GatewayError,
  GatewayErrorCode,
  parseAtomicPlan,
  parseOrder,
  preparedOrder,
  type ValidationSnapshot,
  validateOrder,
} from "@conditional-stocks/gateway";
import {
  ATOMIC_EXECUTION_VERSION,
  type AtomicPlan,
  AtomicPlanError,
  atomicRestingNotional,
  canonicalStringify,
  planAtomicOrder,
  planAtomicRecovery,
} from "@conditional-stocks/orderbook";
import { type Address, getAddress, type Hex, isAddress, isHex, keccak256, toBytes } from "viem";
import type { CanonicalOrder, IndexerClient, ViemGatewayChain } from "./chain.ts";
import type { ApiEnvironment } from "./environment.ts";
import { logger } from "./logger.ts";

const CHALLENGE_TTL_MS = 5n * 60n * 1_000n;
const SESSION_TTL_MS = 24n * 60n * 60n * 1_000n;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

const now = (): bigint => BigInt(Date.now());
const randomToken = (): string => randomBytes(32).toString("base64url");
const digest = (value: unknown): Hex => keccak256(toBytes(canonicalStringify(value)));

const object = (value: unknown, name = "body"): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayError(GatewayErrorCode.InvalidRequest, `${name} must be an object`);
  }
  return value as Record<string, unknown>;
};

const hex = (value: unknown, name: string, bytes?: number): Hex => {
  if (
    typeof value !== "string" ||
    !isHex(value, { strict: true }) ||
    (bytes !== undefined && value.length !== bytes * 2 + 2)
  ) {
    throw new GatewayError(GatewayErrorCode.InvalidRequest, `${name} is invalid hex`);
  }
  return value.toLowerCase() as Hex;
};

export class GatewayService {
  #recoveryTail: Promise<void> = Promise.resolve();
  #recoveryCursor = 0n;
  constructor(
    readonly environment: ApiEnvironment,
    readonly store: GatewayQueries,
    readonly chain: ViemGatewayChain,
    readonly indexer: IndexerClient,
    readonly safety?: TradingSafety,
  ) {}

  async createChallenge(input: unknown) {
    const body = object(input);
    if (typeof body.address !== "string" || !isAddress(body.address)) {
      throw new GatewayError(GatewayErrorCode.InvalidRequest, "address is invalid");
    }
    const address = getAddress(body.address);
    const issuedAt = new Date().toISOString();
    const expiresAtMs = now() + CHALLENGE_TTL_MS;
    const expirationTime = new Date(Number(expiresAtMs)).toISOString();
    const nonce = randomToken().slice(0, 16);
    const message =
      `${this.environment.authDomain} wants you to sign in with your Ethereum account:\n` +
      `${address}\n\nSign in to Conditional Stocks. This does not authorize a transaction.\n\n` +
      `URI: ${this.environment.authOrigin}\nVersion: 1\nChain ID: ${this.environment.chainId}\n` +
      `Nonce: ${nonce}\nIssued At: ${issuedAt}\nExpiration Time: ${expirationTime}`;
    const challengeId = crypto.randomUUID();
    await this.store.saveChallenge(challengeId, address, message, expiresAtMs);
    return { address, challengeId, expiresAtMs, message };
  }

  async verifyChallenge(input: unknown) {
    const body = object(input);
    if (typeof body.address !== "string" || !isAddress(body.address)) {
      throw new GatewayError(GatewayErrorCode.InvalidRequest, "address is invalid");
    }
    if (typeof body.challengeId !== "string") {
      throw new GatewayError(GatewayErrorCode.InvalidRequest, "challengeId is required");
    }
    const signature = hex(body.signature, "signature");
    const address = getAddress(body.address);
    const message = await this.store.consumeChallenge(body.challengeId, address);
    if (!message || !(await this.chain.verifyAuthMessage(address, message, signature))) {
      throw new GatewayError(
        GatewayErrorCode.SignatureInvalid,
        "challenge signature is invalid",
        401,
      );
    }
    const token = randomToken();
    const expiresAtMs = now() + SESSION_TTL_MS;
    await this.store.saveSession(digest(token), address, expiresAtMs);
    return { address, expiresAtMs, token, tokenType: "Bearer" };
  }

  async authenticate(authorization: string | undefined): Promise<Address> {
    const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
    const address = token ? await this.store.sessionAddress(digest(token)) : null;
    if (!address) {
      throw new GatewayError(
        GatewayErrorCode.NotAuthenticated,
        "valid bearer session required",
        401,
      );
    }
    return getAddress(address);
  }

  async prepareOrder(input: unknown, session: Address) {
    const order = parseOrder(object(input).order);
    this.#requireAccount(session, order.maker);
    await this.safety?.assertCanTrade([order.marketId]);
    const snapshot = await this.chain.snapshot(order, this.indexer);
    validateOrder(order, snapshot);
    const execution = await this.chain.executionContext(order);
    const [funding, plan] = await Promise.all([
      this.chain.funding(order, snapshot.market, execution.blockNumber),
      this.#quoteAtomic(order, snapshot, execution),
    ]);
    const preparation = preparedOrder(order, snapshot, this.environment.exchange, funding);
    logger.info("api.order.quoted", {
      orderHash: preparation.orderHash,
      marketId: order.marketId,
      makerCount: plan.makers.length,
      filledQuantity: plan.filledQuantity,
      remainingQuantity: plan.remainingQuantity,
      deadline: plan.deadline,
    });
    return {
      ...preparation,
      plan,
      executionVersion: ATOMIC_EXECUTION_VERSION,
      currentFees: { makerFeeBps: execution.makerFeeBps, takerFeeBps: execution.takerFeeBps },
      fundingReady: preparation.funding.approved && preparation.funding.balanceSufficient,
      atomicRouter: this.environment.atomicRouter,
    };
  }

  /** Read-only execution preparation: never signs, broadcasts, or queues an order. */
  async orderTransaction(input: unknown, session: Address) {
    const body = object(input);
    const order = parseOrder(body.order);
    const plan = parseAtomicPlan(body.plan, order);
    const signature = hex(body.signature, "signature");
    this.#requireAccount(session, order.maker);
    await this.safety?.assertCanTrade([order.marketId]);
    const snapshot = await this.chain.snapshot(order, this.indexer);
    const execution = await this.chain.executionContext(order);
    if (plan.deadline <= execution.timestamp || plan.deadline > execution.timestamp + 60n)
      throw new GatewayError(
        GatewayErrorCode.OrderExpired,
        "Execution quote expired; review a fresh quote",
        409,
      );
    validateOrder(order, snapshot);
    const [funding, currentPlan] = await Promise.all([
      this.chain.funding(order, snapshot.market, execution.blockNumber),
      this.#quoteAtomic(order, snapshot, execution),
    ]);
    // Never accept a client-selected inferior/omitted maker, silently edit a reviewed plan,
    // or extend its deadline. Re-derive current best price/FIFO before returning wallet bytes.
    if (
      canonicalStringify({ ...plan, deadline: 0n }) !==
      canonicalStringify({ ...currentPlan, deadline: 0n })
    )
      throw new GatewayError(
        GatewayErrorCode.OrderInvalid,
        "The best-price execution plan changed; review a fresh quote",
        409,
      );
    const preparation = preparedOrder(order, snapshot, this.environment.exchange, funding);
    if (!preparation.funding.balanceSufficient)
      throw new GatewayError(
        GatewayErrorCode.BalanceInsufficient,
        "Funding balance is insufficient",
      );
    if (!preparation.funding.approved)
      throw new GatewayError(
        GatewayErrorCode.ApprovalMissing,
        "Exchange funding approval is missing",
      );
    if (!(await this.chain.verifyOrderSignature(order, signature, execution.blockNumber)))
      throw new GatewayError(GatewayErrorCode.SignatureInvalid, "Order signature is invalid");
    try {
      await this.chain.simulateAtomic(order, signature, plan);
    } catch {
      throw new GatewayError(
        GatewayErrorCode.SimulationFailed,
        "Atomic execution is no longer valid; refresh the quote. No transaction was broadcast.",
        409,
      );
    }
    await this.safety?.assertCanTrade([order.marketId]);
    return {
      orderHash: preparation.orderHash,
      executionVersion: ATOMIC_EXECUTION_VERSION,
      transaction: {
        chainId: this.environment.chainId,
        from: session,
        to: this.environment.atomicRouter,
        data: this.chain.atomicCalldata(order, signature, plan),
        value: 0n,
      },
    };
  }

  async #quoteAtomic(
    order: Order,
    snapshot: ValidationSnapshot,
    execution: Awaited<ReturnType<ViemGatewayChain["executionContext"]>>,
  ): Promise<AtomicPlan> {
    if (execution.nextSequence !== snapshot.nextSequence)
      throw new GatewayError(
        GatewayErrorCode.CanonicalStateUnavailable,
        "New liquidity is awaiting indexer confirmation; retry the quote shortly",
        503,
      );
    const candidates = await this.indexer.matchCandidates(
      order,
      snapshot,
      execution.makerFeeBps,
      this.environment.exchange,
      execution.timestamp,
    );
    try {
      const plan = planAtomicOrder({
        taker: order,
        candidates,
        chainId: snapshot.chainId,
        exchange: this.environment.exchange,
        timestamp: execution.timestamp,
        baseStep: snapshot.market.baseStep,
        makerFeeBps: execution.makerFeeBps,
        takerFeeBps: execution.takerFeeBps,
        nextSequence: snapshot.nextSequence,
      });
      const resting = atomicRestingNotional({
        taker: order,
        plan,
        marketOpenNotional: snapshot.marketOpenNotional,
        walletOpenNotional: snapshot.walletOpenNotional,
      });
      const needsRecovery =
        resting.market > snapshot.market.maxMarketOpenNotional ||
        resting.wallet > snapshot.market.maxWalletOpenNotional;
      const recovery = planAtomicRecovery({
        taker: order,
        resting,
        maxMarketOpenNotional: snapshot.market.maxMarketOpenNotional,
        maxWalletOpenNotional: snapshot.market.maxWalletOpenNotional,
        candidates: needsRecovery
          ? await this.indexer.staleReservations(
              order,
              snapshot,
              this.environment.exchange,
              execution.timestamp,
            )
          : [],
      });
      return { ...plan, releaseOrders: recovery.releaseOrders };
    } catch (error) {
      if (!(error instanceof AtomicPlanError)) throw error;
      throw new GatewayError(GatewayErrorCode.OrderInvalid, error.message, 409);
    }
  }

  async prepareCancellation(input: unknown, session: Address) {
    const body = object(input);
    const orderHash = hex(body.orderHash, "orderHash", 32);
    const canonical = await this.#openOrderForMaker(orderHash, session);
    return {
      canonical,
      transaction: {
        chainId: this.environment.chainId,
        data: this.chain.cancelOrderCalldata(orderHash),
        from: session,
        to: this.environment.exchange,
        value: 0n,
      },
    };
  }

  /** Permissionless explicit cleanup when an atomic quote needs more than its bounded batch. */
  async prepareOrderRecovery(input: unknown, session: Address) {
    const body = object(input);
    const orderHash = hex(body.orderHash, "orderHash", 32);
    const kind = body.kind;
    if (kind !== "expired" && kind !== "invalidated" && kind !== "closed")
      throw new GatewayError(GatewayErrorCode.InvalidRequest, "Invalid stale-order release kind");
    const data = this.chain.recoveryCalldata(orderHash, kind);
    try {
      await this.chain.simulateUserCall(session, this.environment.exchange, data);
    } catch {
      throw new GatewayError(
        GatewayErrorCode.SimulationFailed,
        "Order is not currently releasable for that reason",
        409,
      );
    }
    return {
      transaction: {
        chainId: this.environment.chainId,
        from: session,
        to: this.environment.exchange,
        data,
        value: 0n,
      },
    };
  }

  /** Recovery remains available during trading freezes and never requires a protocol signer. */
  async preparePayoutWithdrawal(input: unknown, session: Address) {
    const body = object(input);
    const uint256 = (value: unknown, name: string) => {
      if (
        typeof value !== "string" ||
        !/^(0|[1-9][0-9]{0,77})$/.test(value) ||
        BigInt(value) >= 1n << 256n
      )
        throw new GatewayError(
          GatewayErrorCode.InvalidRequest,
          `${name} must be uint256 decimal units`,
        );
      return BigInt(value);
    };
    if (
      typeof body.asset !== "string" ||
      !isAddress(body.asset) ||
      typeof body.recipient !== "string" ||
      !isAddress(body.recipient)
    )
      throw new GatewayError(
        GatewayErrorCode.InvalidRequest,
        "Asset and recipient must be addresses",
      );
    const asset = getAddress(body.asset);
    const recipient = getAddress(body.recipient);
    const tokenId = uint256(body.tokenId, "tokenId");
    const amount = uint256(body.amount, "amount");
    if (
      amount === 0n ||
      /^0x0{40}$/i.test(asset) ||
      /^0x0{40}$/i.test(recipient) ||
      recipient.toLowerCase() === this.environment.payoutVault.toLowerCase() ||
      (asset.toLowerCase() !== this.environment.conditionalTokens.toLowerCase() && tokenId !== 0n)
    )
      throw new GatewayError(GatewayErrorCode.InvalidRequest, "Invalid exact-asset withdrawal");
    const available = await this.chain.payoutCredit(session, asset, tokenId);
    if (amount > available)
      throw new GatewayError(
        GatewayErrorCode.BalanceInsufficient,
        "Withdrawal exceeds your current payout credit",
        409,
      );
    const data = this.chain.payoutWithdrawalCalldata(asset, tokenId, amount, recipient);
    try {
      await this.chain.simulateUserCall(session, this.environment.payoutVault, data);
    } catch {
      throw new GatewayError(
        GatewayErrorCode.SimulationFailed,
        "Payout withdrawal cannot currently execute; try another recipient or retry later",
        409,
      );
    }
    return {
      available,
      transaction: {
        chainId: this.environment.chainId,
        from: session,
        to: this.environment.payoutVault,
        data,
        value: 0n,
      },
    };
  }

  async submitCancellation(input: unknown, session: Address, idempotencyKey: string | undefined) {
    const key = this.#idempotencyKey(idempotencyKey);
    const body = object(input);
    const orderHash = hex(body.orderHash, "orderHash", 32);
    const rawTransaction = hex(body.signedTransaction, "signedTransaction");
    await this.#openOrderForMaker(orderHash, session);
    return await this.#submitUserTransaction({
      data: this.chain.cancelOrderCalldata(orderHash),
      idempotencyKey: key,
      kind: "cancel",
      orderHash,
      rawTransaction,
      session,
      to: this.environment.exchange,
    });
  }

  async canonicalOrder(orderHashInput: string, session: Address) {
    const orderHash = hex(orderHashInput, "orderHash", 32);
    const order = await this.indexer.order(orderHash);
    if (!order) throw new GatewayError(GatewayErrorCode.NotFound, "order not found", 404);
    this.#requireAccount(session, getAddress(order.maker));
    const stored = await this.#findOrderOperation(session, orderHash);
    const application = stored ? await this.#refreshOperation(stored) : null;
    return { application, canonical: order };
  }

  async operation(operationId: string, session: Address) {
    const operation = await this.store.getOperation(operationId);
    if (!operation) throw new GatewayError(GatewayErrorCode.NotFound, "operation not found", 404);
    this.#requireAccount(session, operation.address);
    return {
      attempts: await this.store.listAttempts(operationId),
      operation: await this.#refreshOperation(operation),
    };
  }

  async preparePositionAction(kind: "merge" | "redeem", input: unknown, session: Address) {
    const action = await this.#positionAction(kind, input);
    const approved = await this.chain.positionRouterApproved(session);
    if (approved) {
      try {
        await this.chain.simulateUserCall(session, this.environment.positionRouter, action.data);
      } catch {
        throw new GatewayError(
          GatewayErrorCode.SimulationFailed,
          "Position action cannot currently execute; refresh balances or choose another amount",
          409,
        );
      }
    }
    return {
      approval: approved
        ? null
        : {
            data: this.chain.positionApprovalCalldata(),
            chainId: this.environment.chainId,
            from: session,
            operator: this.environment.positionRouter,
            to: this.environment.conditionalTokens,
            value: 0n,
          },
      approved,
      preview: action.preview,
      transaction: {
        chainId: this.environment.chainId,
        data: action.data,
        from: session,
        to: this.environment.positionRouter,
        value: 0n,
      },
    };
  }

  async submitPositionAction(
    kind: "merge" | "redeem",
    input: unknown,
    session: Address,
    idempotencyKey: string | undefined,
  ) {
    const key = this.#idempotencyKey(idempotencyKey);
    const body = object(input);
    const action = await this.#positionAction(kind, body);
    if (!(await this.chain.positionRouterApproved(session))) {
      throw new GatewayError(
        GatewayErrorCode.ApprovalMissing,
        "position router approval is missing",
      );
    }
    await this.chain.simulateUserCall(session, this.environment.positionRouter, action.data);
    return await this.#submitUserTransaction({
      data: action.data,
      idempotencyKey: key,
      kind,
      orderHash: null,
      rawTransaction: hex(body.signedTransaction, "signedTransaction"),
      session,
      to: this.environment.positionRouter,
    });
  }

  async #submitUserTransaction(input: {
    data: Hex;
    idempotencyKey: string;
    kind: OperationKind;
    orderHash: Hex | null;
    rawTransaction: Hex;
    session: Address;
    to: Address;
  }) {
    const requestDigest = digest({
      data: input.data,
      rawTransaction: input.rawTransaction,
      to: input.to,
    });
    const begun = await this.store.beginOperation({
      address: input.session,
      canonicalState: null,
      error: null,
      finalReceipt: null,
      idempotencyKey: input.idempotencyKey,
      kind: input.kind,
      operationId: crypto.randomUUID(),
      orderHash: input.orderHash,
      payload: { data: input.data, to: input.to },
      requestDigest,
      state: "accepted",
      transactionHash: null,
    });
    if (!begun.created) {
      if (begun.operation.requestDigest !== requestDigest) {
        throw new GatewayError(
          GatewayErrorCode.Conflict,
          "idempotency key was used for another request",
          409,
        );
      }
    }
    return this.#runOperation(begun.operation.operationId, async () => {
      const current = await this.store.getOperation(begun.operation.operationId);
      if (!current) throw new Error("operation disappeared");
      if (!["accepted", "retryable"].includes(current.state) || current.transactionHash)
        return {
          attempts: await this.store.listAttempts(current.operationId),
          operation: await this.#refreshOperation(current),
        };
      try {
        const validated = await this.chain.validateRawTransaction(input.rawTransaction, {
          data: input.data,
          from: input.session,
          to: input.to,
        });
        await this.store.persistPreparedAttempt({
          attempt: 0,
          createdAtMs: now(),
          nonce: validated.nonce,
          operationId: begun.operation.operationId,
          rawTransaction: input.rawTransaction,
          replaces: null,
          transactionHash: validated.transactionHash,
        });
        logger.info("api.outbox.prepared", {
          operationId: begun.operation.operationId,
          kind: input.kind,
          transactionHash: validated.transactionHash,
        });
        await this.store.renewOperation(begun.operation.operationId);
        const transactionHash = await this.chain.broadcast(input.rawTransaction);
        if (transactionHash !== validated.transactionHash)
          throw new Error("RPC returned wrong tx hash");
        const operation = await this.#updateOperation(begun.operation.operationId, {
          state: "broadcast",
        });
        return { attempts: await this.store.listAttempts(operation.operationId), operation };
      } catch (error) {
        const gatewayError =
          error instanceof GatewayError
            ? error
            : new GatewayError(
                GatewayErrorCode.RpcUnavailable,
                "Transaction processing temporarily unavailable; retry the same idempotency key",
                503,
              );
        await this.#updateOperation(begun.operation.operationId, {
          error: { code: gatewayError.code, message: gatewayError.message },
          state: gatewayError.status >= 500 ? "retryable" : "failed",
        });
        throw gatewayError;
      }
    });
  }

  async #positionAction(kind: "merge" | "redeem", input: unknown) {
    const body = object(input);
    const marketId = hex(body.marketId, "marketId", 32);
    const market = await this.indexer.market(marketId);
    if (!market) throw new GatewayError(GatewayErrorCode.NotFound, "market not found", 404);
    const collateral = body.collateral;
    if (collateral !== "base" && collateral !== "quote") {
      throw new GatewayError(GatewayErrorCode.InvalidRequest, "collateral must be base or quote");
    }
    const collateralToken = getAddress(
      collateral === "base" ? market.baseToken : market.quoteToken,
    );
    if (typeof body.recipient !== "string" || !isAddress(body.recipient)) {
      throw new GatewayError(GatewayErrorCode.InvalidRequest, "recipient is invalid");
    }
    const recipient = getAddress(body.recipient);
    const decimal = (value: unknown, name: string): bigint => {
      if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
        throw new GatewayError(GatewayErrorCode.InvalidRequest, `${name} must be positive`);
      }
      return BigInt(value);
    };
    if (kind === "merge") {
      const amount = decimal(body.amount, "amount");
      return {
        data: this.chain.mergeCalldata(collateralToken, market.conditionId, amount, recipient),
        preview: { collateralReturned: amount, collateralToken, recipient },
      };
    }
    if (market.state < 6) {
      throw new GatewayError(GatewayErrorCode.OrderInvalid, "market is not redeemable", 409);
    }
    if (!Array.isArray(body.indexSets) || !Array.isArray(body.amounts)) {
      throw new GatewayError(GatewayErrorCode.InvalidRequest, "indexSets and amounts are required");
    }
    const indexSets = body.indexSets.map((value, index) => decimal(value, `indexSets[${index}]`));
    const amounts = body.amounts.map((value, index) => decimal(value, `amounts[${index}]`));
    if (
      indexSets.length === 0 ||
      indexSets.length > 2 ||
      indexSets.length !== amounts.length ||
      new Set(indexSets).size !== indexSets.length ||
      indexSets.some((value) => value !== 1n && value !== 2n)
    ) {
      throw new GatewayError(GatewayErrorCode.InvalidRequest, "invalid redemption position set");
    }
    const resolution = await this.indexer.resolution(marketId);
    if (!resolution) {
      throw new GatewayError(
        GatewayErrorCode.CanonicalStateUnavailable,
        "resolution not indexed",
        503,
      );
    }
    const denominator = BigInt(resolution.payoutDenominator);
    const payout = indexSets.reduce(
      (total, indexSet, index) =>
        total +
        ((amounts[index] ?? 0n) *
          (indexSet === 1n ? BigInt(resolution.yesPayout) : BigInt(resolution.noPayout))) /
          denominator,
      0n,
    );
    return {
      data: this.chain.redeemCalldata(
        collateralToken,
        market.conditionId,
        indexSets,
        amounts,
        recipient,
      ),
      preview: { collateralToken, payout, recipient },
    };
  }

  async #refreshOperation(operation: OperationRecord): Promise<OperationRecord> {
    const result = await this.#runOperation(operation.operationId, async () => {
      const current = await this.store.getOperation(operation.operationId);
      if (!current) throw new Error("operation disappeared");
      return { operation: await this.#refreshOwnedOperation(current), attempts: [] };
    });
    return result.operation;
  }

  async #refreshOwnedOperation(operation: OperationRecord): Promise<OperationRecord> {
    if (!operation.transactionHash) return operation;
    const receipt = await this.indexer.transaction(operation.transactionHash);
    if (receipt) {
      return await this.#updateOperation(operation.operationId, {
        finalReceipt: receipt,
        state:
          receipt.confirmation === "observed"
            ? "broadcast"
            : receipt.status === "success"
              ? "canonical"
              : "failed",
      });
    }
    const rpcReceipt = await this.chain.receipt(operation.transactionHash);
    if (rpcReceipt?.status === "reverted") {
      return await this.#updateOperation(operation.operationId, {
        error: {
          code: GatewayErrorCode.TransactionReverted,
          message: "RPC transaction receipt reports revert",
        },
        finalReceipt: rpcReceipt,
        state: "failed",
      });
    }
    if (rpcReceipt) {
      operation = await this.#updateOperation(operation.operationId, { finalReceipt: rpcReceipt });
    }
    if (!rpcReceipt && ["prepared", "retryable", "broadcast"].includes(operation.state)) {
      const attempt = await (await this.store.listAttempts(operation.operationId)).at(-1);
      if (attempt?.rawTransaction) {
        if (operation.kind === "order")
          throw new GatewayError(
            GatewayErrorCode.OrderInvalid,
            "Legacy trading outboxes cannot be replayed",
            409,
          );
        await this.store.renewOperation(operation.operationId);
        await this.chain.broadcast(attempt.rawTransaction).catch(() => undefined);
        return await this.#updateOperation(operation.operationId, { state: "broadcast" });
      }
    }
    return operation;
  }

  async reconcilePending(): Promise<void> {
    // Rotate bounded keyset pages so old unprepared requests cannot starve later outboxes.
    // Persisted per-operation ownership allows recovery independently of live intake;
    // recovery only rebroadcasts existing signed bytes and never allocates a new nonce.
    const pass = this.#recoveryTail.then(async () => {
      const page = await this.store.pendingOperationsPage(this.#recoveryCursor, 25);
      this.#recoveryCursor = page.nextSequence;
      for (const operation of page.operations) {
        if (!operation.transactionHash) continue;
        try {
          await this.#refreshOperation(operation);
        } catch (error) {
          logger.debug("api.outbox.recovery.deferred", {
            operationId: operation.operationId,
            orderHash: operation.orderHash,
            error,
          });
          /* Keep the durable operation for the next pass during an outage. */
        }
      }
    });
    this.#recoveryTail = pass.catch(() => undefined);
    await pass;
  }

  async #runOperation(
    id: string,
    work: () => Promise<{
      operation: OperationRecord;
      attempts: Awaited<ReturnType<GatewayQueries["listAttempts"]>>;
    }>,
  ) {
    try {
      return await this.store.withOperation(id, work);
    } catch (error) {
      if (!(error instanceof OperationLeaseUnavailable)) throw error;
      const operation = await this.store.getOperation(id);
      if (!operation) throw new Error("operation disappeared");
      return { operation, attempts: await this.store.listAttempts(id) };
    }
  }

  async #openOrderForMaker(orderHash: Hex, maker: Address): Promise<CanonicalOrder> {
    const canonical = await this.indexer.order(orderHash);
    if (!canonical) throw new GatewayError(GatewayErrorCode.NotFound, "order not found", 404);
    this.#requireAccount(maker, getAddress(canonical.maker));
    if (canonical.status !== "open") {
      throw new GatewayError(GatewayErrorCode.OrderInvalid, `order is ${canonical.status}`, 409);
    }
    return canonical;
  }

  async #updateOperation(
    ...args: Parameters<GatewayQueries["updateOperation"]>
  ): Promise<OperationRecord> {
    const previous = await this.store.getOperation(args[0]);
    const operation = await this.store.updateOperation(...args);
    if (
      previous?.state !== operation.state ||
      previous?.transactionHash !== operation.transactionHash
    ) {
      const fields = {
        operationId: operation.operationId,
        kind: operation.kind,
        previousState: previous?.state,
        state: operation.state,
        orderHash: operation.orderHash,
        transactionHash: operation.transactionHash,
        errorCode: operation.error?.code,
      };
      if (operation.state === "failed" || operation.state === "retryable")
        logger.warn("api.operation.transition", fields);
      else logger.info("api.operation.transition", fields);
    }
    return operation;
  }

  async #findOrderOperation(session: Address, orderHash: Hex): Promise<OperationRecord | null> {
    return await this.store.findOrderOperation(session, orderHash);
  }

  #idempotencyKey(value: string | undefined): string {
    if (!value || !IDEMPOTENCY_PATTERN.test(value)) {
      throw new GatewayError(
        GatewayErrorCode.InvalidRequest,
        "Idempotency-Key must be 8-128 safe ASCII characters",
      );
    }
    return value;
  }

  #requireAccount(actual: Address, expected: Address): void {
    if (getAddress(actual) !== getAddress(expected)) {
      throw new GatewayError(
        GatewayErrorCode.NotAuthenticated,
        "session does not own this action",
        403,
      );
    }
  }
}
