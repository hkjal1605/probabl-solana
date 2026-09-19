import { expect, test } from "bun:test";
import { envelope, PublicKey, SolanaClient, unwrap } from "@conditional-stocks/solana-client";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { vaultAmount, verifiedVaultTransaction } from "../src/lib/trading/vault";
import type { WholeBalanceView } from "../src/types/api";

const client = new SolanaClient({
    rpcUrl: "http://127.0.0.1:8899",
    config: String(PublicKey.unique()),
    genesisHash: "test",
  }),
  owner = String(PublicKey.unique());
function balance(
  mint: PublicKey,
  program: PublicKey,
  wallet: bigint,
  vault: bigint,
): WholeBalanceView {
  return {
    token: String(mint),
    account: owner,
    decimals: 6,
    tokenProgram: String(program),
    canonicalBalance: String(wallet),
    vaultAvailable: String(vault),
    reserved: "0",
    blockNumber: "1",
  };
}
function quote(
  action: "deposit" | "withdraw",
  mint: PublicKey,
  program: PublicKey,
  amount: bigint,
  received: bigint,
) {
  const instructions =
    action === "deposit"
      ? [client.depositPool(new PublicKey(owner), mint, amount, program, received)]
      : client.withdrawPool(
          new PublicKey(owner),
          mint,
          amount,
          new PublicKey(owner),
          program,
          received,
        );
  return {
    transaction: envelope(instructions, client.program),
    scope: "global" as const,
    amount: String(amount),
    minimumReceived: String(received),
    transferFee: String(amount - received),
  };
}

test("only positive u64-precision vault amounts are accepted", () => {
  expect(vaultAmount("1.25", 6)).toBe(1_250_000n);
  for (const invalid of ["", "0", "-1", "0.0000001", "18446744073710"])
    expect(() => vaultAmount(invalid, 6)).toThrow();
});

test("Token-2022 fee floor, external balance and exact server instructions are enforced", () => {
  const mint = PublicKey.unique(),
    b = balance(mint, TOKEN_2022_PROGRAM_ID, 1_000n, 500n);
  const q = quote("deposit", mint, TOKEN_2022_PROGRAM_ID, 600n, 597n);
  expect(
    verifiedVaultTransaction({
      action: "deposit",
      owner,
      mint: String(mint),
      amount: 600n,
      balance: b,
      quote: q,
      client,
    }).received,
  ).toBe("0.000597");
  expect(() =>
    verifiedVaultTransaction({
      action: "deposit",
      owner,
      mint: String(mint),
      amount: 1_001n,
      balance: b,
      quote: quote("deposit", mint, TOKEN_2022_PROGRAM_ID, 1_001n, 998n),
      client,
    }),
  ).toThrow("external wallet");
  expect(() =>
    verifiedVaultTransaction({
      action: "deposit",
      owner,
      mint: String(mint),
      amount: 600n,
      balance: b,
      quote: { ...q, minimumReceived: "596" },
      client,
    }),
  ).toThrow();
  expect(() =>
    verifiedVaultTransaction({
      action: "deposit",
      owner,
      mint: String(mint),
      amount: 600n,
      balance: b,
      quote: {
        ...q,
        transaction: envelope(
          [client.depositPool(new PublicKey(owner), mint, 599n, TOKEN_2022_PROGRAM_ID, 597n)],
          client.program,
        ),
      },
      client,
    }),
  ).toThrow();
  expect(() =>
    verifiedVaultTransaction({
      action: "withdraw",
      owner,
      mint: String(mint),
      amount: 501n,
      balance: b,
      quote: quote("withdraw", mint, TOKEN_2022_PROGRAM_ID, 501n, 500n),
      client,
    }),
  ).toThrow("vault balance");
});

test("native SOL wraps only the deficit before the verified pool deposit", () => {
  const b = balance(NATIVE_MINT, TOKEN_PROGRAM_ID, 100n, 0n);
  const q = quote("deposit", NATIVE_MINT, TOKEN_PROGRAM_ID, 500n, 500n);
  const tx = verifiedVaultTransaction({
    action: "deposit",
    owner,
    mint: String(NATIVE_MINT),
    amount: 500n,
    balance: b,
    quote: q,
    nativeLamports: 30_000_000n,
    client,
  });
  expect(unwrap(tx.transaction, client.program)).toHaveLength(4);
  expect(() =>
    verifiedVaultTransaction({
      action: "deposit",
      owner,
      mint: String(NATIVE_MINT),
      amount: 500n,
      balance: b,
      quote: q,
      nativeLamports: 1_000n,
      client,
    }),
  ).toThrow("Not enough SOL");
});
