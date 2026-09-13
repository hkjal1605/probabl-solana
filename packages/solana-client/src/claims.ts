import { U64_MAX } from "./protocol.ts";

function amount(value: bigint) {
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX)
    throw new Error("Claim amount is outside u64");
}
export function payoutDenominator(payouts: readonly number[]): bigint {
  if (
    payouts.length !== 2 ||
    ![
      [1, 0],
      [0, 1],
      [1, 1],
    ].some(([y, n]) => payouts[0] === y && payouts[1] === n)
  )
    throw new Error("Invalid finalized payout");
  return BigInt(payouts[0]! + payouts[1]!);
}

/** Independent of vault balances: supply includes externally held claims. */
export function requiredClaimBacking(
  yes: bigint,
  no: bigint,
  payouts?: readonly number[],
) {
  amount(yes);
  amount(no);
  if (payouts === undefined) return yes > no ? yes : no;
  const denominator = payoutDenominator(payouts);
  const weighted = yes * BigInt(payouts[0]!) + no * BigInt(payouts[1]!);
  return (weighted + denominator - 1n) / denominator;
}

/** Exact contract semantics: never silently burn fractional raw-unit value. */
export function exactRedemption(
  yes: bigint,
  no: bigint,
  payouts: readonly number[],
) {
  amount(yes);
  amount(no);
  const denominator = payoutDenominator(payouts);
  const weighted = yes * BigInt(payouts[0]!) + no * BigInt(payouts[1]!);
  if (weighted % denominator !== 0n)
    throw new Error(
      "Redemption would discard a fractional raw unit; retain or combine the odd claim",
    );
  return weighted / denominator;
}

/** Plan only, not a transaction: merge pairs, then redeem representable excess.
 * Any odd INVALID remainder remains a real, transferable claim owned by the user.
 * No fractional IOU state, rounding carry, or reassignment of another user's dust. */
export function planRedemption(
  yes: bigint,
  no: bigint,
  payouts: readonly number[],
) {
  amount(yes);
  amount(no);
  const denominator = payoutDenominator(payouts);
  const merge = yes < no ? yes : no;
  let redeemYes = yes - merge,
    redeemNo = no - merge;
  let retainedYes = 0n,
    retainedNo = 0n;
  if (denominator === 2n) {
    retainedYes = redeemYes % 2n;
    retainedNo = redeemNo % 2n;
    redeemYes -= retainedYes;
    redeemNo -= retainedNo;
  }
  const credit = merge + exactRedemption(redeemYes, redeemNo, payouts);
  return {
    merge,
    redeemYes,
    redeemNo,
    retainedYes,
    retainedNo,
    credit,
    burnYes: yes - retainedYes,
    burnNo: no - retainedNo,
  };
}
export type RedemptionPlan = ReturnType<typeof planRedemption>;
