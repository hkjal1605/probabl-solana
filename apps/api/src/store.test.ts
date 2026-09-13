import { afterEach, describe, expect, test } from "bun:test";
import { createGatewayQueries, type GatewayQueries } from "@conditional-stocks/db/gateway";
import { testDatabase } from "@conditional-stocks/db/testing";
import { getAddress, type Hex } from "viem";

const stores: GatewayQueries[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

describe("gateway durable state", () => {
  test("consumes auth challenges once and hashes sessions", async () => {
    const store = createGatewayQueries((await testDatabase()).database);
    stores.push(store);
    const address = getAddress("0x1000000000000000000000000000000000000001");
    const tokenHash = `0x${"11".repeat(32)}` as Hex;
    await store.saveChallenge("challenge", address, "message", 2_000n);
    expect(await store.consumeChallenge("challenge", address, 1_000n)).toBe("message");
    expect(await store.consumeChallenge("challenge", address, 1_000n)).toBeNull();
    await store.saveSession(tokenHash, address, 2_000n);
    expect((await store.sessionAddress(tokenHash, 1_000n))?.toLowerCase()).toBe(
      address.toLowerCase(),
    );
    expect(await store.sessionAddress(tokenHash, 2_001n)).toBeNull();
  });

  test("atomically deduplicates operation keys without allocating wallet nonces", async () => {
    const store = createGatewayQueries((await testDatabase()).database);
    stores.push(store);
    const address = getAddress("0x1000000000000000000000000000000000000001");
    const hash = `0x${"11".repeat(32)}` as Hex;
    const input = {
      address,
      canonicalState: null,
      error: null,
      finalReceipt: null,
      idempotencyKey: "request-0001",
      kind: "order" as const,
      operationId: "operation",
      orderHash: hash,
      payload: { value: 1n },
      requestDigest: hash,
      state: "accepted" as const,
      transactionHash: null,
    };
    expect((await store.beginOperation(input)).created).toBeTrue();
    expect((await store.beginOperation({ ...input, operationId: "another" })).created).toBeFalse();
  });

  test("preparation persists nonce, attempt, and operation atomically", async () => {
    const store = createGatewayQueries((await testDatabase()).database);
    stores.push(store);
    const address = getAddress("0x1000000000000000000000000000000000000001");
    const hash = `0x${"11".repeat(32)}` as Hex;
    await store.beginOperation({
      address,
      canonicalState: null,
      error: null,
      finalReceipt: null,
      idempotencyKey: "atomic-0001",
      kind: "order",
      operationId: "atomic",
      orderHash: hash,
      payload: {},
      requestDigest: hash,
      state: "accepted",
      transactionHash: null,
    });
    const attempt = {
      attempt: 0,
      createdAtMs: 1n,
      nonce: 7n,
      operationId: "atomic",
      rawTransaction: "0x1234" as Hex,
      replaces: null,
      transactionHash: hash,
    };
    expect(await store.listAttempts("atomic")).toHaveLength(0);
    await store.persistPreparedAttempt(attempt);
    expect((await store.getOperation("atomic"))?.state).toBe("prepared");
    expect((await store.getOperation("atomic"))?.transactionHash).toBe(hash);
    await expect(
      (async () => await store.persistPreparedAttempt({ ...attempt, nonce: 8n }))(),
    ).rejects.toThrow();
  });
});
