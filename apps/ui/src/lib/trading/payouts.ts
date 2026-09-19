import {
  SolanaClient,
  envelope,
  key,
  verifyEnvelope,
  type Deployment,
} from "@conditional-stocks/solana-client";
type WithdrawalInput = {
  credit: {
    scope: "global" | "market";
    beneficiary: string;
    asset: string;
    tokenId: string;
    amount: string;
    marketId?: string | null;
  };
  amount: bigint;
  recipient: string;
  account: string;
  config: Deployment;
};
export function payoutWithdrawal(
  input: WithdrawalInput,
  quote?: { program: import("@solana/web3.js").PublicKey; received: bigint },
) {
  const { credit, amount } = input;
  if (
    credit.beneficiary !== input.account ||
    (credit.scope === "market" ? !credit.marketId : credit.scope !== "global" || Boolean(credit.marketId)) ||
    amount <= 0n ||
    amount > BigInt(credit.amount)
  )
    throw new Error("Invalid payout beneficiary or amount");
  const asset = Number(credit.tokenId);
  if (credit.scope === "market" && (!Number.isInteger(asset) || asset < 2 || asset > 5))
    throw new Error("Invalid asset index");
  const client = new SolanaClient(input.config);
  if (credit.scope === "global") return envelope(client.withdrawPool(
    key(input.account), key(credit.asset), amount, key(input.recipient), quote?.program, quote?.received,
  ), client.program);
  return envelope(
    client.withdraw(
      key(credit.marketId!),
      key(input.account),
      key(credit.asset),
      asset,
      amount,
      key(input.recipient),
      quote?.program,
      quote?.received,
    ),
    client.program,
  );
}
export async function preparePayoutWithdrawal(input: WithdrawalInput) {
  // Validate the local beneficiary/amount before issuing any RPC request.
  payoutWithdrawal(input);
  const quote = await new SolanaClient(input.config).withdrawalQuote(
    key(input.credit.asset),
    input.amount,
  );
  return { transaction: payoutWithdrawal(input, quote), ...quote };
}
export const verifyPayoutResponse = verifyEnvelope;
