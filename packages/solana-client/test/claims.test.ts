import { expect, test } from "bun:test";
import {
  Keypair,
  ComputeBudgetProgram,
  ComputeBudgetInstruction,
  TransactionInstruction,
  TransactionMessage,
} from "@solana/web3.js";
import {
  exactRedemption,
  planRedemption,
  requiredClaimBacking,
  SolanaClient,
  bn,
  coder,
  claimAddress,
  vaultAddress,
  unwrap,
  envelope,
  type MarketAccount,
  type WalletAccount,
} from "../src/index.ts";

const maximum = (1n << 64n) - 1n;
test("local placement preparation budgets CPI guards without accepting remote priority fees", async () => {
  const f = clientFixture();
  f.client.assertNetwork = async () => {};
  f.client.connection.getLatestBlockhash = async () => ({
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 100,
  });
  const placement = (count: number) =>
    new TransactionInstruction({
      programId: f.client.program,
      keys: [],
      data: coder.instruction.encode("place", {
        terms: {
          recipient: f.owner,
          salt: Array(32).fill(0),
          quantity: bn(1),
          price: bn(10n ** 18n),
          expiry: bn(100),
          nonce: bn(0),
          max_fee_bps: 0,
          branch: 0,
          side: 0,
          funding: 0,
          tif: 0,
        },
        plan: {
          deadline: bn(50),
          next_sequence: bn(0),
          maker_bps: 0,
          taker_bps: 0,
          legs: Array.from({ length: count }, () => ({
            quantity: bn(1),
            expected_remaining: bn(1),
          })),
        },
      }),
    });
  for (const legs of [0, 1, 2, 8]) {
    const ix = placement(legs),
      original = Buffer.from(ix.data);
    const tx = await f.client.prepareTransaction(f.owner, envelope([ix]));
    const instructions = TransactionMessage.decompile(
      tx.transaction.message,
    ).instructions;
    expect(instructions).toHaveLength(legs ? 2 : 1);
    expect(instructions.at(-1)!.data.equals(original)).toBe(true);
    if (legs) {
      expect(
        ComputeBudgetInstruction.decodeInstructionType(instructions[0]!),
      ).toBe("SetComputeUnitLimit");
      expect(
        ComputeBudgetInstruction.decodeSetComputeUnitLimit(instructions[0]!)
          .units,
      ).toBe(200_000 + 100_000 * legs);
    }
    const pinned = await f.client.prepareTransaction(f.owner, envelope([ix]), {
      pinWalletFees: true,
    });
    const pinnedInstructions = TransactionMessage.decompile(
      pinned.transaction.message,
    ).instructions;
    expect(pinnedInstructions).toHaveLength(3);
    expect(
      ComputeBudgetInstruction.decodeSetComputeUnitLimit(pinnedInstructions[0]!).units,
    ).toBe(200_000 + 100_000 * legs);
    expect(
      ComputeBudgetInstruction.decodeSetComputeUnitPrice(pinnedInstructions[1]!).microLamports,
    ).toBe(0n);
    expect(pinnedInstructions[2]!.data.equals(original)).toBe(true);
  }
  const capped = await f.client.prepareTransaction(
    f.owner,
    envelope([placement(8), placement(8)]),
  );
  expect(
    ComputeBudgetInstruction.decodeSetComputeUnitLimit(
      TransactionMessage.decompile(capped.transaction.message).instructions[0]!,
    ).units,
  ).toBe(1_400_000);
  await expect(
    f.client.prepareTransaction(f.owner, envelope([placement(9)])),
  ).rejects.toThrow("compute plan");
  await expect(
    f.client.prepareTransaction(
      f.owner,
      envelope([
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }),
      ]),
    ),
  ).rejects.toThrow("Unsupported instruction");
});

test("INVALID combines odd pairs exactly and never destroys fractional raw units", () => {
  expect(exactRedemption(1n, 1n, [1, 1])).toBe(1n);
  expect(exactRedemption(11n, 19n, [1, 1])).toBe(15n);
  expect(exactRedemption(maximum, maximum, [1, 1])).toBe(maximum);
  expect(() => exactRedemption(1n, 0n, [1, 1])).toThrow("fractional raw unit");
  expect(() => exactRedemption(0n, maximum, [1, 1])).toThrow(
    "fractional raw unit",
  );
  expect(exactRedemption(maximum, maximum, [1, 0])).toBe(maximum);
  expect(exactRedemption(maximum, 0n, [0, 1])).toBe(0n); // explicit losing-claim burn
  for (const payouts of [[0, 0], [2, 1], [1], [1, 1, 0], [1, NaN]])
    expect(() => planRedemption(1n, 1n, payouts)).toThrow();
  for (const value of [-1n, maximum + 1n]) {
    expect(() => exactRedemption(value, 1n, [1, 0])).toThrow();
    expect(() => requiredClaimBacking(1n, value)).toThrow();
  }
});

test("merge-first recovery maximizes exact payout while retaining every unpaid fractional claim", () => {
  for (const y of [0n, 1n, 2n, 3n, 19n, maximum - 1n, maximum])
    for (const n of [0n, 1n, 2n, 3n, 11n, maximum - 1n, maximum])
      for (const payouts of [
        [1, 0],
        [0, 1],
        [1, 1],
      ]) {
        const p = planRedemption(y, n, payouts);
        const den = BigInt(payouts[0]! + payouts[1]!);
        const weight = y * BigInt(payouts[0]!) + n * BigInt(payouts[1]!);
        expect(p.credit).toBe(weight / den);
        expect(p.burnYes + p.retainedYes).toBe(y);
        expect(p.burnNo + p.retainedNo).toBe(n);
        expect(p.merge + p.redeemYes).toBe(p.burnYes);
        expect(p.merge + p.redeemNo).toBe(p.burnNo);
        expect(
          p.credit * den +
            p.retainedYes * BigInt(payouts[0]!) +
            p.retainedNo * BigInt(payouts[1]!),
        ).toBe(weight);
        expect(requiredClaimBacking(y, n, payouts)).toBe(
          (weight + den - 1n) / den,
        );
        expect(requiredClaimBacking(y, n)).toBe(y > n ? y : n);
      }
  expect(planRedemption(1n, 0n, [1, 1])).toMatchObject({
    burnYes: 0n,
    credit: 0n,
    retainedYes: 1n,
  });
  expect(planRedemption(3n, 2n, [1, 1])).toMatchObject({
    merge: 2n,
    credit: 2n,
    retainedYes: 1n,
  });
});

function clientFixture() {
  const key = () => Keypair.generate().publicKey;
  const market = key(),
    owner = key();
  const client = new SolanaClient({
    rpcUrl: "http://127.0.0.1:8897",
    config: key().toBase58(),
    genesisHash: "test",
  });
  const state = {
    state: 6,
    payouts: [1, 1],
    mints: [
      key(),
      key(),
      ...Array.from({ length: 4 }, (_, i) => claimAddress(market, i + 2)),
    ],
  } as MarketAccount;
  client.market = async () => state;
  client.wallet = async () =>
    ({ balances: [0, 0, 1, 1, 0, 0].map(bn) }) as WalletAccount;
  const deposits: { asset: number; credit: bigint }[] = [];
  client.depositForCredit = async (m, o, mint, asset, credit) => {
    deposits.push({ asset, credit });
    return {
      instruction: client.deposit(m, o, mint, asset, credit),
      gross: credit,
      fee: 0n,
    };
  };
  return { client, market, owner, state, deposits };
}

test("reviewed recovery bytes fund only burned claims and bind the read-only underlying vault", async () => {
  const f = clientFixture();
  const tx = await f.client.redemptionTransaction(f.market, f.owner, 0, 4n, 1n);
  expect(tx.recovery).toMatchObject({
    merge: 1n,
    redeemYes: 2n,
    retainedYes: 1n,
    credit: 2n,
    burnYes: 3n,
    burnNo: 1n,
  });
  expect(f.deposits).toEqual([{ asset: 2, credit: 2n }]);
  const ixs = unwrap(tx);
  expect(ixs.map((ix) => coder.instruction.decode(ix.data)!.name)).toEqual([
    "deposit",
    "merge",
    "redeem",
  ]);
  for (const ix of ixs.slice(1)) {
    const underlying = ix.keys.at(-1)!;
    expect(underlying.pubkey.equals(vaultAddress(f.market, 0))).toBe(true);
    expect(underlying.isWritable).toBe(false);
    expect(underlying.isSigner).toBe(false);
  }
  const combined = f.client.redeem(f.market, f.owner, 0, 1n, 1n);
  const decoded = coder.instruction.decode(combined.data)!.data as {
    yes_amount: { toString(): string };
    no_amount: { toString(): string };
  };
  expect(decoded.yes_amount.toString()).toBe("1");
  expect(decoded.no_amount.toString()).toBe("1");
});

test("unredeemable odd claim stays put; legacy high-level single-branch funding fails before deposit", async () => {
  const f = clientFixture();
  const tx = await f.client.redemptionTransaction(f.market, f.owner, 0, 1n, 0n);
  expect(tx.executable).toBe(false);
  expect(() => unwrap(tx)).toThrow("Invalid instruction bundle");
  expect(tx.recovery.retainedYes).toBe(1n);
  await expect(
    f.client.positionTransaction("redeem", f.market, f.owner, 0, 3n),
  ).rejects.toThrow("fractional raw unit");
  expect(f.deposits).toHaveLength(0);
  f.state.state = 2;
  await expect(
    f.client.redemptionTransaction(f.market, f.owner, 0, 1n, 1n),
  ).rejects.toThrow("not redeemable");
  for (const collateral of [-1, 2, 255])
    expect(() =>
      f.client.redeem(f.market, f.owner, collateral, 1n, 1n),
    ).toThrow();
});
