import { expect, test } from "bun:test";
import { DEVNET_ASSET_MINTS } from "@conditional-stocks/shared/spot-prices";
import { ACCOUNT_SIZE, AccountLayout, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { HTTPException } from "hono/http-exception";
import { Faucet, FAUCET_AMOUNTS, faucetAssets, faucetBatches, rawUnits } from "../../src/solana/faucet/faucet.ts";

test("faucet amounts convert exactly and reject excess precision", () => {
  expect(rawUnits("0.005", 8)).toBe(500_000n);
  expect(rawUnits("500", 6)).toBe(500_000_000n);
  expect(rawUnits("0.02", 9)).toBe(20_000_000n);
  expect(() => rawUnits("0.0000001", 6)).toThrow("Invalid faucet amount");
  expect(() => rawUnits("-1", 6)).toThrow("Invalid faucet amount");
});

test("faucet assets list SOL, the mocks, then configured replicas, batched without delivered ones", () => {
  const replica = Keypair.generate().publicKey.toBase58();
  const assets = faucetAssets({ NVDAx: replica, UNKNOWN: replica });
  expect(assets.map((a) => a.symbol)).toEqual(["SOL", "USDC", "BTC", "ETH", "NVDAx"]);
  expect(assets[0]!.mint).toBeNull();
  expect(assets[4]!.mint!.toBase58()).toBe(replica);
  const batches = faucetBatches(assets, ["SOL", "BTC"], 2);
  expect(batches.map((b) => b.map((a) => a.symbol))).toEqual([["USDC", "ETH"], ["NVDAx"]]);
  for (const symbol of Object.keys(FAUCET_AMOUNTS)) expect(() => rawUnits(FAUCET_AMOUNTS[symbol]!, 6)).not.toThrow();
});

/** In-memory claim store and RPC that settle every transaction instantly. */
function harness(options: { lamports?: number; tokens?: bigint; failures?: number } = {}) {
  const signer = Keypair.generate();
  const claims = new Map<string, { delivered: string[]; signatures: string[]; completedAt: Date | null }>();
  const queries = {
    async faucetClaim(_domain: string, owner: string) {
      return claims.get(owner);
    },
    async recordFaucetDelivery(_domain: string, owner: string, delivered: string[], signature: string | null, complete: boolean) {
      const row = claims.get(owner) ?? { delivered: [], signatures: [], completedAt: null };
      row.delivered.push(...delivered);
      if (signature) row.signatures.push(signature);
      if (complete) row.completedAt ??= new Date();
      claims.set(owner, row);
    },
    async faucetClaimsSince() {
      return claims.size;
    },
  };
  // Writes inside the lock's transaction would roll back with it; only reads are allowed there.
  const inLock = {
    ...queries,
    recordFaucetDelivery: () => Promise.reject(new Error("deliveries must be recorded outside the lock")),
  };
  const db = { ...queries, locked: <T>(_lock: string, work: (q: typeof queries) => Promise<T>) => work(inLock) };
  let failures = options.failures ?? 0;
  const sent: VersionedTransaction[] = [];
  const mint = new PublicKey(DEVNET_ASSET_MINTS.USDC);
  const source = getAssociatedTokenAddressSync(mint, signer.publicKey, false, TOKEN_PROGRAM_ID);
  const tokenAccount = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint,
      owner: signer.publicKey,
      amount: options.tokens ?? 10n ** 12n,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    tokenAccount,
  );
  const connection = {
    getBalance: async () => options.lamports ?? 1_000_000_000,
    getAccountInfo: async (address: PublicKey) =>
      address.equals(source) ? { data: tokenAccount, owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false } : null,
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
    sendRawTransaction: async (raw: Uint8Array) => {
      sent.push(VersionedTransaction.deserialize(raw));
      return `sig${sent.length}`;
    },
    getSignatureStatuses: async () => ({
      value: [{ confirmationStatus: "confirmed", err: failures-- > 0 ? { InstructionError: [0, "Custom"] } : null }],
    }),
    getBlockHeight: async () => 1,
  };
  const faucet = new Faucet({ connection } as never, signer, db as never, "test", [
    { symbol: "SOL", mint: null },
    { symbol: "USDC", mint },
  ]);
  // Mint metadata normally comes from chain.
  (faucet as unknown as { mints: Map<string, unknown> }).mints.set("USDC", { program: TOKEN_PROGRAM_ID, decimals: 6 });
  return { faucet, signer, claims, sent };
}

test("a wallet claims every asset once, signed by the faucet only", async () => {
  const { faucet, signer, claims, sent } = harness();
  const owner = Keypair.generate().publicKey.toBase58();
  expect(await faucet.status(owner)).toMatchObject({ available: true, claimed: false });
  const result = await faucet.claim(owner);
  expect(result.sent).toEqual([
    { symbol: "SOL", amount: "0.02" },
    { symbol: "USDC", amount: "500" },
  ]);
  expect(result.unavailable).toEqual([]);
  expect(sent).toHaveLength(1);
  const message = sent[0]!.message;
  expect(message.header.numRequiredSignatures).toBe(1);
  expect(message.staticAccountKeys[0]!.equals(signer.publicKey)).toBe(true);
  expect(claims.get(owner)).toMatchObject({ delivered: ["SOL", "USDC"], signatures: ["sig1"] });
  expect(await faucet.status(owner)).toMatchObject({ claimed: true });
  const again = await faucet.claim(owner).catch((error: unknown) => error);
  expect(again).toBeInstanceOf(HTTPException);
  expect((again as HTTPException).status).toBe(409);
  expect(sent).toHaveLength(1);
});

test("an empty token balance is skipped, low SOL and self-claims are refused", async () => {
  const dry = harness({ tokens: 1n });
  const result = await dry.faucet.claim(Keypair.generate().publicKey.toBase58());
  expect(result.sent.map((s) => s.symbol)).toEqual(["SOL"]);
  expect(result.unavailable).toEqual(["USDC"]);

  const poor = harness({ lamports: 1_000 });
  const refused = await poor.faucet.claim(Keypair.generate().publicKey.toBase58()).catch((error: unknown) => error);
  expect((refused as HTTPException).status).toBe(503);
  expect(poor.sent).toHaveLength(0);

  const self = harness();
  await expect(self.faucet.claim(self.signer.publicKey.toBase58())).rejects.toThrow("cannot claim from itself");
});

test("a transfer that fails on chain leaves the claim open for a retry", async () => {
  const { faucet, claims, sent } = harness({ failures: 1 });
  const owner = Keypair.generate().publicKey.toBase58();
  await expect(faucet.claim(owner)).rejects.toThrow("failed on chain");
  expect(claims.get(owner)).toBeUndefined();
  const retry = await faucet.claim(owner);
  expect(retry.sent.map((s) => s.symbol)).toEqual(["SOL", "USDC"]);
  expect(sent).toHaveLength(2);
  expect(claims.get(owner)?.completedAt).toBeInstanceOf(Date);
});
