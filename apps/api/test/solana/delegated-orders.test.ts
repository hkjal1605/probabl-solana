import { expect, test } from "bun:test";
import type { SolanaDatabase } from "@conditional-stocks/db/solana";
import {
  bn,
  delegationAddress,
  type OrderWire,
  orderSalt,
  SolanaClient,
} from "@conditional-stocks/solana-client";
import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { custodyFixture } from "../../../../services/solana-indexer/test/custody-fixture";
import {
  delegatedSimulationFailure,
  submitDelegatedOrder,
  tradingPermission,
  tradingSigner,
} from "../../src/solana/trading/delegated-orders.ts";

test("simulation failures retry only stale plans and expose safe actionable messages", () => {
  expect(
    delegatedSimulationFailure([
      "Program log: AnchorError occurred. Error Code: StalePlan. Error Number: 6008.",
    ]),
  ).toEqual({
    retryable: true,
    code: "StalePlan",
    message: "The order book changed while placing the order.",
  });
  expect(delegatedSimulationFailure(["Program log: Error Code: InsufficientFunds."])).toEqual({
    retryable: false,
    code: "InsufficientFunds",
    message: "Your available vault balance is insufficient for this order.",
  });
  expect(delegatedSimulationFailure(["private rpc detail"]).message).toBe(
    "The order could not execute against the current on-chain state.",
  );
  expect(delegatedSimulationFailure(["private rpc detail"]).retryable).toBe(false);
});

test("delegated submission waits for the index and replans an explicitly stale simulation", async () => {
  const { s, owner, config } = custodyFixture();
  const signer = Keypair.generate();
  s.traders.set(String(owner), { delegation_epoch: bn(0) } as never);
  const grantAddress = String(delegationAddress(config, owner, signer.publicKey, s.program));
  s.delegations?.set(grantAddress, {
    config,
    owner,
    delegate: signer.publicKey,
    market: PublicKey.default,
    epoch: bn(0),
    expires_at: bn(BigInt(Math.floor(Date.now() / 1000) + 3600)),
    max_order_quote: bn(1000),
    remaining_quote: bn(10000),
    max_fee_bps: 100,
    permissions: 1,
    revoked: false,
    bump: 0,
  });
  const marketId = [...s.markets.keys()][0];
  if (!marketId) throw new Error("Missing market fixture");
  const nonce = BigInt(Date.now());
  const order: OrderWire = {
    maker: String(owner),
    delegate: String(signer.publicKey),
    recipient: String(owner),
    marketId,
    salt: orderSalt(nonce, new Uint8Array(32).fill(4)),
    quantity: "1",
    limitPriceRawX18: "1",
    expiry: String(Math.floor(Date.now() / 1000) + 600),
    nonce: String(nonce),
    maxFeeBps: 0,
    branch: 0,
    side: 0,
    fundingKind: 0,
    tif: 1,
    bases: 1,
  };
  let simulations = 0;
  let sends = 0;
  const instruction = new TransactionInstruction({
    programId: s.program,
    keys: [],
    data: Buffer.from([1]),
  });
  const client = {
    config,
    program: s.program,
    wallet: async () => ({}),
    initializeWallet: () => instruction,
    placement: () => instruction,
    prepareTransaction: async () => ({
      transaction: new VersionedTransaction(
        new TransactionMessage({
          payerKey: signer.publicKey,
          recentBlockhash: PublicKey.default.toBase58(),
          instructions: [instruction],
        }).compileToV0Message(),
      ),
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 1000,
    }),
    connection: {
      simulateTransaction: async () => {
        simulations++;
        return simulations === 1
          ? {
              context: { slot: 105 },
              value: {
                err: { InstructionError: [0, { Custom: 6008 }] },
                logs: ["Program log: AnchorError. Error Code: StalePlan."],
              },
            }
          : { context: { slot: 106 }, value: { err: null, logs: [] } };
      },
      getSignatureStatuses: async () => ({ value: [null] }),
      getBlockHeight: async () => 10,
      sendRawTransaction: async (bytes: Uint8Array) => {
        sends++;
        const signature = VersionedTransaction.deserialize(bytes).signatures[0];
        if (!signature) throw new Error("Missing mock signature");
        return bs58.encode(signature);
      },
      confirmTransaction: async () => ({ context: { slot: 106 }, value: { err: null } }),
    },
  } as unknown as SolanaClient;
  type Submission = {
    order_terms_hash: string;
    owner: string;
    delegate: string;
    signature: string;
    signed_transaction: Buffer;
    last_valid_block_height: string;
  };
  let submission: Submission | undefined;
  const queries = {
    delegatedSubmission: async () => submission,
    delegatedSubmissionCount: async () => 0,
    recordDelegatedSubmission: async (
      _domain: string,
      _orderHash: string,
      orderTermsHash: string,
      beneficialOwner: string,
      delegate: string,
      signature: string,
      signedTransaction: Uint8Array,
      lastValidBlockHeight: number,
    ) => {
      submission = {
        order_terms_hash: orderTermsHash,
        owner: beneficialOwner,
        delegate,
        signature,
        signed_transaction: Buffer.from(signedTransaction),
        last_valid_block_height: String(lastValidBlockHeight),
      };
      return submission;
    },
  };
  const db = {
    locked: async (_lock: string, work: (value: typeof queries) => Promise<unknown>) =>
      work(queries),
  } as unknown as SolanaDatabase;
  let snapshotReads = 0;
  const result = await submitDelegatedOrder({
    client,
    db,
    domain: "test",
    signer,
    owner: String(owner),
    order,
    snapshot: async () => {
      snapshotReads++;
      return snapshotReads === 1 ? s : { ...s, slot: 105 };
    },
    prepare: async (_candidate, snapshot, prefix) => {
      expect(snapshot?.slot === 100 || snapshot?.slot === 105).toBe(true);
      // The wallet exists, so the placement carries no initializer to size for.
      expect(prefix).toEqual([]);
      return { plan: {} as never };
    },
  });
  expect(result.orderHash).toBeString();
  if (!submission) throw new Error("Submission was not journaled");
  expect(result.signature).toBe(submission.signature);
  expect(simulations).toBe(2);
  expect(snapshotReads).toBe(2);
  expect(sends).toBe(1);
});

test("dedicated signer validation withholds private key and refuses mismatched public key", () => {
  const key = Keypair.generate();
  const secret = JSON.stringify([...key.secretKey]);
  expect(tradingSigner(undefined, undefined)).toBeNull();
  expect(tradingSigner(secret, String(key.publicKey))?.publicKey.equals(key.publicKey)).toBe(true);
  expect(() => tradingSigner(secret, String(Keypair.generate().publicKey))).toThrow("matching");
  expect(() => tradingSigner("invalid", undefined)).toThrow("value withheld");
});

test("public permission reflects only an active protocol-wide grant for this owner and key", () => {
  const { s, owner, config } = custodyFixture();
  const signer = Keypair.generate();
  const client = new SolanaClient({
    rpcUrl: "http://127.0.0.1:8899",
    config: String(config),
    genesisHash: "test",
    programId: String(s.program),
  });
  const base = tradingPermission(s, client, signer, String(owner));
  expect(base.available).toBe(true);
  expect(base.active).toBe(false);
  expect(base.grant).toBeNull();
  s.traders.set(String(owner), { delegation_epoch: bn(0) } as never);
  const id = String(delegationAddress(config, owner, signer.publicKey, s.program));
  const grant = {
    config,
    owner,
    delegate: signer.publicKey,
    market: PublicKey.default,
    epoch: bn(0),
    expires_at: bn(BigInt(Math.floor(Date.now() / 1000) + 3600)),
    max_order_quote: bn(1000),
    remaining_quote: bn(10000),
    max_fee_bps: 100,
    permissions: 1,
    revoked: false,
    bump: 0,
  };
  if (!s.delegations) throw new Error("Delegation fixture is missing");
  s.delegations.set(id, grant);
  expect(tradingPermission(s, client, signer, String(owner)).active).toBe(true);
  grant.market = PublicKey.unique();
  expect(tradingPermission(s, client, signer, String(owner)).active).toBe(false);
  grant.market = PublicKey.default;
  grant.revoked = true;
  expect(tradingPermission(s, client, signer, String(owner)).active).toBe(false);
  grant.revoked = false;
  grant.remaining_quote = bn(0);
  expect(tradingPermission(s, client, signer, String(owner)).active).toBe(false);
});
