import {
  address,
  big,
  envelope,
  key,
  type SolanaClient,
  unsigned,
  walletAddress,
} from "@conditional-stocks/solana-client";
import { globalAvailable } from "@conditional-stocks/solana-indexer/custody";
import type { Snapshot } from "@conditional-stocks/solana-indexer/projection";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

/** The authenticated signer owns the credit. No caller-supplied owner or delegate
 * can select someone else's pool/market balance. Only issuer fee metadata uses RPC. */
export async function prepareVaultTransfer(
  client: SolanaClient,
  s: Snapshot,
  owner: string,
  body: {
    asset: string;
    amount: string;
    recipient?: string;
    scope?: string;
    marketId?: string;
    tokenId?: string;
  },
  action: "deposit" | "withdraw",
) {
  const mint = key(address(body.asset)),
    amount = unsigned(body.amount),
    signer = key(owner);
  if (!amount) throw new Error("Amount must be positive");
  const recipient = body.recipient ? key(address(body.recipient)) : signer;
  if (body.scope === "market") {
    if (!body.marketId || (action === "deposit" && body.recipient))
      throw new Error("Invalid market claim transfer");
    const market = s.markets.get(body.marketId),
      asset = Number(body.tokenId);
    if (
      !market ||
      !Number.isInteger(asset) ||
      asset < 2 ||
      asset > 5 ||
      !market.mints[asset]?.equals(mint)
    )
      throw new Error("Claim mint does not belong to this market");
    const marketKey = key(body.marketId);
    const wallet = s.wallets.get(String(walletAddress(marketKey, signer, client.program)));
    if (action === "withdraw" && (!wallet || big(wallet.balances[asset] ?? 0) < amount))
      throw new Error("Insufficient available market claims");
    return {
      transaction: envelope(
        action === "deposit"
          ? [
              ...(!wallet ? [client.initializeWallet(marketKey, signer)] : []),
              client.deposit(marketKey, signer, mint, asset, amount, TOKEN_PROGRAM_ID),
            ]
          : client.withdraw(marketKey, signer, mint, asset, amount, recipient),
        client.program,
      ),
    };
  }
  if (body.scope !== "global" || body.marketId)
    throw new Error("Global vault operations must not select a market");
  const pool = [...s.pools.values()].find((p) => p.mint.equals(mint));
  if (!pool) throw new Error("Underlying asset pool is not initialized");
  if (action === "withdraw" && globalAvailable(s, owner, String(mint)) < amount)
    throw new Error("Insufficient available global credit");
  const quote = await client.withdrawalQuote(mint, amount);
  if (!quote.program.equals(pool.token_program)) throw new Error("Pool token program mismatch");
  const instructions =
    action === "deposit"
      ? [client.depositPool(signer, mint, amount, quote.program, quote.received)]
      : client.withdrawPool(signer, mint, amount, recipient, quote.program, quote.received);
  return {
    transaction: envelope(instructions, client.program),
    amount: String(amount),
    minimumReceived: String(quote.received),
    transferFee: String(quote.fee),
    scope: "global",
  };
}
