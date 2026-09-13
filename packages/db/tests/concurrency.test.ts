import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createGatewayQueries,
  OperationLeaseLost,
  OperationLeaseUnavailable,
} from "../src/gateway/queries.ts";
import { gatewayOperations } from "../src/schema.ts";
import { testDatabase } from "../src/testing.ts";

const address = "0x1000000000000000000000000000000000000001";
const hash = `0x${"11".repeat(32)}` as const;
const operation = {
  address: address as `0x${string}`,
  canonicalState: null,
  error: null,
  finalReceipt: null,
  idempotencyKey: "concurrency-01",
  kind: "order" as const,
  operationId: "operation",
  orderHash: hash,
  payload: {},
  requestDigest: hash,
  state: "accepted" as const,
  transactionHash: null,
};

test("operation leases reject competing requests and fence expired writers across independent pools", async () => {
  const fixture = await testDatabase();
  const a = createGatewayQueries(fixture.database);
  const b = createGatewayQueries(fixture.connect());
  const results = await Promise.all([
    a.beginOperation(operation),
    b.beginOperation({ ...operation, operationId: "duplicate" }),
  ]);
  expect(results.filter((result) => result.created)).toHaveLength(1);
  const id = results[0]?.operation.operationId;
  if (!id) throw new Error("operation fixture missing");
  await a.withOperation(id, async () => {
    await a.withOperation(id, async () => {
      await a.renewOperation(id);
    });
    await expect(b.withOperation(id, async () => "must not execute")).rejects.toBeInstanceOf(
      OperationLeaseUnavailable,
    );
    await expect(b.updateOperation(id, { state: "failed" })).rejects.toBeInstanceOf(
      OperationLeaseUnavailable,
    );
    await fixture.db
      .update(gatewayOperations)
      .set({ leaseExpiresAtMs: 0n })
      .where(eq(gatewayOperations.operationId, id));
    await b.withOperation(id, async () => {
      await b.updateOperation(id, { state: "canonical" });
      await expect(a.updateOperation(id, { state: "retryable" })).rejects.toBeInstanceOf(
        OperationLeaseLost,
      );
      await expect(a.renewOperation(id)).rejects.toBeInstanceOf(OperationLeaseLost);
      await expect(
        a.persistPreparedAttempt({
          operationId: id,
          attempt: 0,
          nonce: 1n,
          createdAtMs: 1n,
          replaces: null,
          rawTransaction: "0x12",
          transactionHash: hash,
        }),
      ).rejects.toBeInstanceOf(OperationLeaseLost);
    });
  });
  expect((await b.getOperation(id))?.state).toBe("canonical");
  expect(await b.listAttempts(id)).toEqual([]);
  await expect(
    a.withOperation(id, async () => {
      throw new Error("injected failure");
    }),
  ).rejects.toThrow("injected failure");
  expect(await b.withOperation(id, async () => "recovered")).toBe("recovered");
  await expect(a.withOperation(id, async () => {}, 0n)).rejects.toThrow("duration");
  await expect(a.withOperation("missing", async () => {})).rejects.toThrow("not found");
  await expect(a.renewOperation(id)).rejects.toBeInstanceOf(OperationLeaseLost);
});

test("an old request cannot release the lease of a replacement request", async () => {
  const fixture = await testDatabase();
  const a = createGatewayQueries(fixture.database);
  const b = createGatewayQueries(fixture.connect());
  await a.beginOperation(operation);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let replacement: Promise<void> | undefined;
  await a.withOperation(operation.operationId, async () => {
    await fixture.db
      .update(gatewayOperations)
      .set({ leaseExpiresAtMs: 0n })
      .where(eq(gatewayOperations.operationId, operation.operationId));
    replacement = b.withOperation(operation.operationId, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
  });
  try {
    await expect(a.withOperation(operation.operationId, async () => {})).rejects.toBeInstanceOf(
      OperationLeaseUnavailable,
    );
  } finally {
    release.resolve();
    await replacement;
  }
});

test("transaction failures never implicitly replay in-memory side effects", async () => {
  const { database } = await testDatabase();
  for (const code of ["40001", "40P01", "08006"]) {
    let calls = 0;
    await expect(
      database.transaction(async () => {
        calls++;
        throw Object.assign(new Error("injected rollback"), { code });
      }),
    ).rejects.toThrow("injected rollback");
    expect(calls).toBe(1);
  }
});
