import { AsyncLocalStorage } from "node:async_hooks";
import { canonicalParse, canonicalStringify } from "@conditional-stocks/orderbook";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, notInArray } from "drizzle-orm";
import type { Address, Hex } from "viem";
import { type ApplicationDatabase, boundedLimit } from "../connection.ts";
import {
  gatewayAttempts as attempts,
  authChallenges,
  authSessions,
  gatewayOperations as operations,
} from "../schema.ts";
import type { OperationKind, OperationRecord, TransactionAttempt } from "./types.ts";

export type {
  OperationKind,
  OperationRecord,
  OperationState,
  TransactionAttempt,
} from "./types.ts";

const now = () => BigInt(Date.now());
const parse = (row: { payload: string } | undefined): OperationRecord | null =>
  row ? canonicalParse<OperationRecord>(row.payload) : null;

export class OperationLeaseUnavailable extends Error {
  constructor() {
    super("operation is being processed by another request");
  }
}
export class OperationLeaseLost extends Error {
  constructor() {
    super("operation ownership expired; retry the same idempotency key");
  }
}

export function createGatewayQueries(database: ApplicationDatabase) {
  const db = () => database.session;
  const lock = <T>(id: string, work: () => Promise<T>) =>
    database.locked(`gateway:operation:${id}`, work);
  const ownership = new AsyncLocalStorage<{ id: string; token: bigint; ttlMs: bigint }>();
  async function assertOwnership(id: string) {
    const [row] = await db()
      .select({ token: operations.leaseToken, expires: operations.leaseExpiresAtMs })
      .from(operations)
      .where(eq(operations.operationId, id));
    if (!row) throw new Error(`operation ${id} not found`);
    const grant = ownership.getStore();
    const atMs = await database.nowMs();
    if (grant?.id === id) {
      if (grant.token !== row.token || row.expires <= atMs) throw new OperationLeaseLost();
    } else if (row.expires > atMs) throw new OperationLeaseUnavailable();
  }
  /** Network work runs outside a transaction. The server-clock lease fences every write. */
  async function withOperation<T>(id: string, work: () => Promise<T>, ttlMs = 60_000n): Promise<T> {
    if (ownership.getStore()?.id === id) return work();
    if (ttlMs <= 0n || ttlMs > 300_000n) throw new RangeError("invalid operation lease duration");
    const grant = await lock(id, async () => {
      const [row] = await db()
        .select({ token: operations.leaseToken, expires: operations.leaseExpiresAtMs })
        .from(operations)
        .where(eq(operations.operationId, id));
      if (!row) throw new Error(`operation ${id} not found`);
      const atMs = await database.nowMs();
      if (row.expires > atMs) throw new OperationLeaseUnavailable();
      const token = row.token + 1n;
      await db()
        .update(operations)
        .set({ leaseToken: token, leaseExpiresAtMs: atMs + ttlMs })
        .where(eq(operations.operationId, id));
      return { id, token, ttlMs };
    });
    try {
      return await ownership.run(grant, work);
    } finally {
      // A timed-out request must not release a successor's lease. Failure to release is
      // safe: the persisted expiry permits recovery, even after process termination.
      await db()
        .update(operations)
        .set({ leaseExpiresAtMs: 0n })
        .where(and(eq(operations.operationId, id), eq(operations.leaseToken, grant.token)));
    }
  }
  async function renewOperation(id: string) {
    await lock(id, async () => {
      await assertOwnership(id);
      const grant = ownership.getStore();
      if (grant?.id !== id) throw new OperationLeaseLost();
      await db()
        .update(operations)
        .set({ leaseExpiresAtMs: (await database.nowMs()) + grant.ttlMs })
        .where(eq(operations.operationId, id));
    });
  }
  async function saveChallenge(id: string, address: Address, message: string, expiresAtMs: bigint) {
    await db()
      .insert(authChallenges)
      .values({ id, address: address.toLowerCase(), message, expiresAtMs });
  }
  async function pruneExpiredAuth(atMs = now(), limit = 500) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000)
      throw new RangeError("invalid auth cleanup limit");
    return database.transaction(async () => {
      const challenges = await db()
        .select({ id: authChallenges.id })
        .from(authChallenges)
        .where(lt(authChallenges.expiresAtMs, atMs))
        .orderBy(authChallenges.expiresAtMs)
        .limit(limit)
        .for("update", { skipLocked: true });
      const sessions = await db()
        .select({ id: authSessions.tokenHash })
        .from(authSessions)
        .where(lt(authSessions.expiresAtMs, atMs))
        .orderBy(authSessions.expiresAtMs)
        .limit(limit)
        .for("update", { skipLocked: true });
      if (challenges.length)
        await db()
          .delete(authChallenges)
          .where(
            inArray(
              authChallenges.id,
              challenges.map((x) => x.id),
            ),
          );
      if (sessions.length)
        await db()
          .delete(authSessions)
          .where(
            inArray(
              authSessions.tokenHash,
              sessions.map((x) => x.id),
            ),
          );
      return { challenges: challenges.length, sessions: sessions.length };
    });
  }
  async function consumeChallenge(
    id: string,
    address: Address,
    atMs = now(),
  ): Promise<string | null> {
    const [row] = await db()
      .update(authChallenges)
      .set({ consumedAtMs: atMs })
      .where(
        and(
          eq(authChallenges.id, id),
          eq(authChallenges.address, address.toLowerCase()),
          isNull(authChallenges.consumedAtMs),
          gte(authChallenges.expiresAtMs, atMs),
        ),
      )
      .returning({ message: authChallenges.message });
    return row?.message ?? null;
  }
  async function saveSession(tokenHash: Hex, address: Address, expiresAtMs: bigint) {
    await db()
      .insert(authSessions)
      .values({ tokenHash, address: address.toLowerCase(), expiresAtMs });
  }
  async function sessionAddress(tokenHash: Hex, atMs = now()): Promise<Address | null> {
    const [row] = await db()
      .select({ address: authSessions.address })
      .from(authSessions)
      .where(
        and(
          eq(authSessions.tokenHash, tokenHash),
          isNull(authSessions.revokedAtMs),
          gte(authSessions.expiresAtMs, atMs),
        ),
      );
    return (row?.address as Address | undefined) ?? null;
  }
  async function findOperation(address: Address, kind: OperationKind, idempotencyKey: string) {
    return parse(
      (
        await db()
          .select({ payload: operations.payload })
          .from(operations)
          .where(
            and(
              eq(operations.address, address.toLowerCase()),
              eq(operations.kind, kind),
              eq(operations.idempotencyKey, idempotencyKey),
            ),
          )
      )[0],
    );
  }
  async function getOperation(operationId: string) {
    return parse(
      (
        await db()
          .select({ payload: operations.payload })
          .from(operations)
          .where(eq(operations.operationId, operationId))
      )[0],
    );
  }
  async function findOrderOperation(address: Address, orderHash: Hex) {
    return parse(
      (
        await db()
          .select({ payload: operations.payload })
          .from(operations)
          .where(
            and(
              eq(operations.address, address.toLowerCase()),
              eq(operations.kind, "order"),
              eq(operations.orderHash, orderHash),
            ),
          )
          .orderBy(desc(operations.sequence))
          .limit(1)
      )[0],
    );
  }
  async function beginOperation(input: Omit<OperationRecord, "createdAtMs" | "updatedAtMs">) {
    return database.locked(
      `gateway:request:${JSON.stringify([input.address.toLowerCase(), input.kind, input.idempotencyKey])}`,
      async () => {
        const existing = await findOperation(input.address, input.kind, input.idempotencyKey);
        if (existing) return { created: false, operation: existing };
        const atMs = now();
        const operation: OperationRecord = { ...input, createdAtMs: atMs, updatedAtMs: atMs };
        await db()
          .insert(operations)
          .values({
            operationId: operation.operationId,
            address: operation.address.toLowerCase(),
            kind: operation.kind,
            idempotencyKey: operation.idempotencyKey,
            requestDigest: operation.requestDigest,
            orderHash: operation.orderHash,
            state: operation.state,
            payload: canonicalStringify(operation),
          });
        return { created: true, operation };
      },
    );
  }
  async function updateOperation(
    operationId: string,
    update: Partial<
      Pick<
        OperationRecord,
        "canonicalState" | "error" | "finalReceipt" | "orderHash" | "state" | "transactionHash"
      >
    >,
  ): Promise<OperationRecord> {
    return lock(operationId, async () => {
      await assertOwnership(operationId);
      const operation = await getOperation(operationId);
      if (!operation) throw new Error(`operation ${operationId} not found`);
      if (
        Object.entries(update).every(
          ([key, value]) =>
            canonicalStringify(operation[key as keyof OperationRecord]) ===
            canonicalStringify(value),
        )
      )
        return operation;
      Object.assign(operation, update, { updatedAtMs: now() });
      await db()
        .update(operations)
        .set({
          state: operation.state,
          orderHash: operation.orderHash,
          payload: canonicalStringify(operation),
        })
        .where(eq(operations.operationId, operationId));
      return operation;
    });
  }
  async function addAttempt(attempt: TransactionAttempt) {
    await lock(attempt.operationId, async () => {
      await assertOwnership(attempt.operationId);
      await db()
        .insert(attempts)
        .values({
          operationId: attempt.operationId,
          attempt: attempt.attempt,
          transactionHash: attempt.transactionHash,
          payload: canonicalStringify(attempt),
        });
    });
  }
  async function listAttempts(operationId: string): Promise<TransactionAttempt[]> {
    return (
      await db()
        .select({ payload: attempts.payload })
        .from(attempts)
        .where(eq(attempts.operationId, operationId))
        .orderBy(asc(attempts.attempt))
    ).map((row) => canonicalParse<TransactionAttempt>(row.payload));
  }
  async function persistPreparedAttempt(attempt: TransactionAttempt) {
    await lock(attempt.operationId, async () => {
      await assertOwnership(attempt.operationId);
      await addAttempt(attempt);
      await updateOperation(attempt.operationId, {
        state: "prepared",
        transactionHash: attempt.transactionHash,
      });
    });
  }
  async function pendingOperations(limit = 100): Promise<OperationRecord[]> {
    return (await pendingOperationsPage(0n, limit)).operations;
  }
  async function pendingOperationsPage(afterSequence = 0n, limit = 25) {
    const pageSize = boundedLimit(limit);
    const rows = await db()
      .select({ sequence: operations.sequence, payload: operations.payload })
      .from(operations)
      .where(
        and(
          notInArray(operations.state, ["canonical", "failed"]),
          gt(operations.sequence, afterSequence),
        ),
      )
      .orderBy(asc(operations.sequence))
      .limit(pageSize);
    return {
      operations: rows.map((row) => canonicalParse<OperationRecord>(row.payload)),
      nextSequence: rows.length < pageSize ? 0n : (rows.at(-1)?.sequence ?? 0n),
    };
  }
  return {
    withOperation,
    renewOperation,
    saveChallenge,
    pruneExpiredAuth,
    consumeChallenge,
    saveSession,
    sessionAddress,
    beginOperation,
    findOperation,
    getOperation,
    findOrderOperation,
    updateOperation,
    addAttempt,
    listAttempts,
    persistPreparedAttempt,
    pendingOperations,
    pendingOperationsPage,
    close: database.close,
  };
}
export type GatewayQueries = ReturnType<typeof createGatewayQueries>;
