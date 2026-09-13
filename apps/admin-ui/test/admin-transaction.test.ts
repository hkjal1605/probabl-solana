import { expect, test } from "bun:test";
import { hashCanonical, normalizeGammaMarket } from "@conditional-stocks/market-data";
import { envelope, SolanaClient, unwrap, wireInstruction } from "@conditional-stocks/solana-client";
import { evidenceTransaction, preflightAdmin } from "@conditional-stocks/solana-client/admin";
import { buildCreationEvidence } from "@conditional-stocks/solana-client/evidence";
import {
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import { gammaMarket } from "../../../packages/market-data/tests/helpers";
import { signReviewedTransaction } from "../src/lib/admin-transaction";
import { buildBatchPlans, defaultMarketCaps } from "../src/lib/market-batch";

function fixture() {
  // Ephemeral test keys and mocked RPC only; never load a deployment private key.
  const owner = Keypair.generate(),
    pubkey = () => Keypair.generate().publicKey.toBase58();
  const deployment = {
    rpcUrl: "http://127.0.0.1:8899",
    config: pubkey(),
    programId: pubkey(),
    genesisHash: pubkey(),
    marketAdmin: owner.publicKey.toBase58(),
    resolutionAdmin: owner.publicKey.toBase58(),
  };
  const raw = gammaMarket();
  const source = {
    normalized: normalizeGammaMarket(raw),
    rawHash: hashCanonical(raw),
    snapshotId: "signing-fixture",
  };
  const nowMs = Date.parse("2026-09-13T00:00:00Z");
  const [plan] = buildBatchPlans({
    deployment,
    owner: deployment.marketAdmin,
    source,
    nowMs,
    quote: { address: pubkey(), decimals: 6, standard: "SPL Token" },
    shared: {
      tradingOpen: String(nowMs / 1000),
      tradingCutoff: "1798761600",
      metadataUri: source.normalized.canonicalUrl,
      sourceUrls: source.normalized.canonicalUrl,
    },
    rows: [
      {
        mint: { address: pubkey(), decimals: 6, standard: "Token-2022" },
        caps: defaultMarketCaps(6, 6),
      },
    ],
  });
  if (!plan) throw new Error("Missing fixture plan");
  const packet = buildCreationEvidence({
    ...plan.body,
    deployment,
    preparer: deployment.marketAdmin,
    preparedAt: new Date(nowMs).toISOString(),
    metadata: source.normalized,
    metadataRawHash: source.rawHash,
  });
  const transaction = evidenceTransaction(packet, "create-market", deployment);
  const client = new SolanaClient(deployment);
  const latest = { blockhash: pubkey(), lastValidBlockHeight: 100 };
  const simulated: Uint8Array[] = [];
  client.assertNetwork = async () => {};
  client.connection.getLatestBlockhash = async () => latest;
  client.connection.getAccountInfo = async () => ({
    executable: true,
    data: Buffer.alloc(0),
    owner: SystemProgram.programId,
    lamports: 1,
    rentEpoch: 0,
  });
  client.connection.simulateTransaction = async (value: unknown) => {
    if (!(value instanceof VersionedTransaction)) throw new Error("Expected a v0 transaction");
    simulated.push(Uint8Array.from(value.message.serialize()));
    return { context: { slot: 1 }, value: { err: null, logs: [] } };
  };
  return { client, transaction, owner, simulated, latest };
}

// Model Phantom's documented auto-fee insertion on an unsigned message with no budget.
// https://docs.phantom.com/developer-powertools/solana-priority-fees
function autoFeeWallet(owner: Keypair) {
  let rewrites = 0;
  return {
    get rewrites() {
      return rewrites;
    },
    async sign(value: VersionedTransaction) {
      const message = TransactionMessage.decompile(value.message);
      if (!message.instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId))) {
        rewrites++;
        message.instructions.unshift(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000n }),
        );
      }
      const signed = new VersionedTransaction(message.compileToV0Message());
      signed.sign([owner]);
      return signed;
    },
  };
}

test("reproduces the old create-market mismatch and pins fees before admin simulation/signing", async () => {
  const f = fixture();
  const old = await f.client.prepareTransaction(f.owner.publicKey, f.transaction);
  const wallet = autoFeeWallet(f.owner);
  await expect(signReviewedTransaction(old.transaction, wallet.sign)).rejects.toThrow(
    "No transaction was sent",
  );
  expect(wallet.rewrites).toBe(1);

  const built = await preflightAdmin(f.client, f.transaction);
  const message = TransactionMessage.decompile(built.transaction.message);
  expect(message.instructions).toHaveLength(3);
  expect(ComputeBudgetInstruction.decodeSetComputeUnitLimit(message.instructions[0]!).units).toBe(
    200_000,
  );
  expect(
    ComputeBudgetInstruction.decodeSetComputeUnitPrice(message.instructions[1]!).microLamports,
  ).toBe(0n);
  expect(message.instructions.slice(2).map(wireInstruction)).toEqual(
    unwrap(f.transaction, f.client.program).map(wireInstruction),
  );
  expect(built.blockhash).toBe(f.latest.blockhash);
  expect(built.lastValidBlockHeight).toBe(f.latest.lastValidBlockHeight);
  expect(message.payerKey.equals(f.owner.publicKey)).toBe(true);

  const signed = await signReviewedTransaction(built.transaction, wallet.sign);
  expect(wallet.rewrites).toBe(1);
  expect(Buffer.from(signed.message.serialize()).equals(Buffer.from(f.simulated[0]!))).toBe(true);
  expect(signed.signatures[0]!.some((byte) => byte !== 0)).toBe(true);
});

test("strict signing still rejects fee, instruction, authority, account, order and blockhash changes", async () => {
  const f = fixture();
  const built = await preflightAdmin(f.client, f.transaction);
  const mutations: ((message: TransactionMessage) => void)[] = [
    (m) => {
      m.instructions[0] = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
    },
    (m) => {
      m.instructions[1] = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1n });
    },
    (m) => {
      m.instructions[2]!.data[0]! ^= 1;
    },
    (m) => {
      m.instructions[2]!.programId = SystemProgram.programId;
    },
    (m) => {
      m.instructions[2]!.keys[1]!.pubkey = Keypair.generate().publicKey;
    },
    (m) => {
      m.instructions[2]!.keys[1]!.isWritable = !m.instructions[2]!.keys[1]!.isWritable;
    },
    (m) => {
      m.instructions[2]!.keys[1]!.isSigner = true;
    },
    (m) => {
      m.payerKey = Keypair.generate().publicKey;
    },
    (m) => {
      m.recentBlockhash = Keypair.generate().publicKey.toBase58();
    },
    (m) => {
      m.instructions.push(
        SystemProgram.transfer({
          fromPubkey: f.owner.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1,
        }),
      );
    },
    (m) => {
      m.instructions.pop();
    },
    (m) => {
      m.instructions.reverse();
    },
  ];
  for (const mutate of mutations) {
    let broadcasts = 0;
    const flow = async () => {
      await signReviewedTransaction(built.transaction, async (value) => {
        const message = TransactionMessage.decompile(
          VersionedTransaction.deserialize(value.serialize()).message,
        );
        mutate(message);
        return new VersionedTransaction(message.compileToV0Message());
      });
      broadcasts++;
    };
    await expect(flow()).rejects.toThrow("Wallet changed the reviewed instruction bundle");
    expect(broadcasts).toBe(0);
  }
});

test("signing snapshots bytes before in-place wallet mutation, permits signature-only changes and propagates rejection", async () => {
  const f = fixture();
  const built = await preflightAdmin(f.client, f.transaction);
  const signed = await signReviewedTransaction(built.transaction, async (value) => {
    value.sign([f.owner]);
    return value;
  });
  expect(signed).toBe(built.transaction);
  await expect(
    signReviewedTransaction(built.transaction, async () => {
      throw new Error("User rejected request");
    }),
  ).rejects.toThrow("User rejected request");
  await expect(
    signReviewedTransaction(built.transaction, async (value) => {
      value.message.compiledInstructions[2]!.data[0]! ^= 1;
      return value;
    }),
  ).rejects.toThrow("Wallet changed");
});

test("admin fee pinning never accepts remote fee instructions and checks packet size after adding local fees", async () => {
  const f = fixture();
  for (const ix of [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 999_999n }),
  ]) {
    await expect(
      preflightAdmin(f.client, { ...f.transaction, ...envelope([ix], f.client.program) }),
    ).rejects.toThrow("Unsupported instruction");
  }
  const oversized = envelope(
    [
      new TransactionInstruction({
        programId: f.client.program,
        keys: [],
        data: Buffer.alloc(1020),
      }),
    ],
    f.client.program,
  );
  const plain = await f.client.prepareTransaction(f.owner.publicKey, oversized);
  expect(plain.transaction.serialize().length).toBeLessThanOrEqual(1232);
  await expect(preflightAdmin(f.client, { ...f.transaction, ...oversized })).rejects.toThrow(
    "packet limit",
  );
  expect(f.simulated).toHaveLength(0);
});

test("a failed admin preflight never reaches wallet signing", async () => {
  const f = fixture();
  f.client.connection.simulateTransaction = (async () => ({
    context: { slot: 1 },
    value: { err: { InstructionError: [2, { Custom: 6000 }] }, logs: [] },
  })) as typeof f.client.connection.simulateTransaction;
  let signs = 0;
  const flow = async () => {
    const built = await preflightAdmin(f.client, f.transaction);
    return signReviewedTransaction(built.transaction, async (value) => {
      signs++;
      return value;
    });
  };
  await expect(flow()).rejects.toThrow("Admin simulation failed");
  expect(signs).toBe(0);
});
