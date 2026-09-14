import { expect, test } from "bun:test";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { SolanaClient } from "@conditional-stocks/solana-client";
import { Executor, signer } from "../src/execution";
import { initialState } from "../src/state";
import { config } from "./fixtures";

function fixture() {
  const wallet = Keypair.generate(),
    state = initialState("test"),
    ix = SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: wallet.publicKey,
      lamports: 1,
    });
  let sends = 0,
    saves = 0,
    status: unknown = null,
    height = 90,
    ambiguous = false,
    simulationError = false,
    after = 999995000,
    guardExpired = false;
  const client = {
    program: wallet.publicKey,
    prepareTransaction: async () => ({
      transaction: new VersionedTransaction(
        new TransactionMessage({
          payerKey: wallet.publicKey,
          recentBlockhash: Keypair.generate().publicKey.toBase58(),
          instructions: [ix],
        }).compileToV0Message(),
      ),
      blockhash: "test",
      lastValidBlockHeight: 100,
    }),
    connection: {
      getBalance: async () => 1000000000,
      simulateTransaction: async () => ({
        value: { err: simulationError ? {} : null, accounts: [{ lamports: after }] },
      }),
      sendRawTransaction: async (raw: Uint8Array) => {
        sends++;
        expect(state.pending).toBeDefined();
        expect(saves).toBeGreaterThan(0);
        if (ambiguous) throw new Error("timeout");
        return bs58.encode(VersionedTransaction.deserialize(raw).signatures[0]!);
      },
      confirmTransaction: async () => ({ context: { slot: 123 }, value: { err: null } }),
      getSignatureStatuses: async () => ({ value: [status] }),
      getBlockHeight: async () => height,
    },
  } as unknown as SolanaClient;
  const executor = new Executor(client, wallet, config, state, () => saves++);
  return {
    executor,
    state,
    wallet,
    ix,
    client,
    get sends() {
      return sends;
    },
    set: (patch: {
      ambiguous?: boolean;
      simulationError?: boolean;
      after?: number;
      status?: unknown;
      height?: number;
      guardExpired?: boolean;
    }) => {
      if (patch.ambiguous !== undefined) ambiguous = patch.ambiguous;
      if (patch.simulationError !== undefined) simulationError = patch.simulationError;
      if (patch.after !== undefined) after = patch.after;
      if ("status" in patch) status = patch.status;
      if (patch.height !== undefined) height = patch.height;
      if (patch.guardExpired !== undefined) guardExpired = patch.guardExpired;
    },
    guard: () => !guardExpired,
  };
}
test("signer accepts only a complete, matching dedicated keypair without logging key material", () => {
  const wallet = Keypair.generate(),
    secret = bs58.encode(wallet.secretKey),
    address = wallet.publicKey.toBase58();
  expect(signer(secret, address).publicKey.toBase58()).toBe(address);
  expect(signer(JSON.stringify([...wallet.secretKey]), address).publicKey.toBase58()).toBe(address);
  for (const bad of [
    "not-a-key",
    JSON.stringify([...wallet.secretKey.slice(0, 32)]),
    JSON.stringify(Array(64).fill(256)),
  ])
    expect(() => signer(bad, address)).toThrow("value withheld");
  expect(() => signer(secret, Keypair.generate().publicKey.toBase58())).toThrow("value withheld");
});
test("simulate, reserve rent/fees and persist signature before broadcast; confirm before next action", async () => {
  const f = fixture();
  await f.executor.send([f.ix]);
  expect(f.sends).toBe(1);
  expect(f.state.pending).toBeUndefined();
  expect(f.state.spent).toBe("5000");
  expect(f.state.lastSlot).toBe(123);
});
test("ambiguous submission cannot create another transaction until signature resolution", async () => {
  const f = fixture();
  f.set({ ambiguous: true });
  await expect(f.executor.send([f.ix])).rejects.toThrow();
  expect(f.state.pending).toBeDefined();
  await expect(f.executor.send([f.ix])).rejects.toThrow("pending");
  await expect(f.executor.reconcilePending()).rejects.toThrow("unresolved");
  expect(f.sends).toBe(1);
  f.set({ status: { confirmationStatus: "confirmed", slot: 124, err: null } });
  await f.executor.reconcilePending();
  expect(f.state.pending).toBeUndefined();
  expect(f.state.lastSlot).toBe(124);
});
test("unknown signature only releases its journal after finalized blockhash expiry", async () => {
  const f = fixture();
  f.set({ ambiguous: true });
  await expect(f.executor.send([f.ix])).rejects.toThrow();
  f.set({ height: 100 });
  await expect(f.executor.reconcilePending()).rejects.toThrow();
  f.set({ height: 101 });
  await f.executor.reconcilePending();
  expect(f.state.pending).toBeUndefined();
  expect(f.state.spent).toBe("5000");
});
test("simulation, late reference expiry, fee budget and SOL reserve failures send nothing", async () => {
  for (const scenario of ["simulation", "guard", "budget", "reserve"]) {
    const f = fixture();
    if (scenario === "simulation") f.set({ simulationError: true });
    if (scenario === "guard") f.set({ guardExpired: true });
    if (scenario === "budget") f.state.spent = config.dailySolBudgetLamports;
    if (scenario === "reserve") f.set({ after: 99999999 });
    await expect(f.executor.send([f.ix], false, f.guard)).rejects.toThrow();
    expect(f.sends).toBe(0);
    expect(f.state.pending).toBeUndefined();
  }
  const f = fixture();
  let checks = 0;
  await expect(f.executor.send([f.ix], false, () => ++checks === 1)).rejects.toThrow(
    "during simulation",
  );
  expect(f.sends).toBe(0);
});
test("emergency cancellation can use reserved gas after quote budget is exhausted", async () => {
  const f = fixture();
  f.state.spent = config.dailySolBudgetLamports;
  await f.executor.send([f.ix], true);
  expect(f.sends).toBe(1);
  const g = fixture();
  g.set({ after: 999900000 });
  await expect(g.executor.send([g.ix], true)).rejects.toThrow();
});
