import { SolanaClient,key,big,underlyingAsset } from "@conditional-stocks/solana-client";
import { protocolConfig } from "@/config/protocol";
import type { MarketView } from "@/types/api";
export const solana=()=>new SolanaClient(protocolConfig);
/** Canonical market read; the indexed quote, issuer legs and units must match the program exactly. */
export async function readClaimMarket(market:MarketView){const client=solana();await client.assertNetwork();const m=await client.market(key(market.id));
  const legs=market.bases.every(leg=>m.mints[underlyingAsset(leg.collateral)]?.toBase58()===leg.mint&&m.decimals[leg.collateral]===leg.decimals);
  if(m.mints[0]!.toBase58()!==market.quoteToken||m.decimals[0]!==market.quoteTokenDecimals||m.bases!==market.bases.length||!legs
    ||m.terms.share_decimals!==market.shareDecimals)throw new Error("Indexed market differs from the Solana program.");
  return {...m,conditionId:market.id,tradingCutoff:big(m.terms.trading_cutoff)};
}
export async function transactionReceipt(signature:string){
  const client=solana();await client.assertNetwork();
  const status=await client.connection.getSignatureStatuses([signature],{searchTransactionHistory:true});
  const value=status.value[0];if(!value)throw new Error("Transaction is not confirmed yet.");
  return {status:value.err?"reverted":"success",blockNumber:BigInt(value.slot)};
}
