import { SolanaClient,key,big } from "@conditional-stocks/solana-client";
import { protocolConfig } from "@/config/protocol";
import type { MarketView } from "@/lib/api/types";
export const solana=()=>new SolanaClient(protocolConfig);
export async function readClaimMarket(market:MarketView){const client=solana();await client.assertNetwork();const m=await client.market(key(market.id));
  if(m.mints[0]!.toBase58()!==market.baseToken||m.mints[1]!.toBase58()!==market.quoteToken
    ||m.decimals[0]!==market.baseTokenDecimals||m.decimals[1]!==market.quoteTokenDecimals)throw new Error("Indexed market differs from the Solana program.");
  return {...m,conditionId:market.id,tradingCutoff:big(m.terms.trading_cutoff)};
}
export async function transactionReceipt(signature:string){
  const client=solana();await client.assertNetwork();
  const status=await client.connection.getSignatureStatuses([signature],{searchTransactionHistory:true});
  const value=status.value[0];if(!value)throw new Error("Transaction is not confirmed yet.");
  return {status:value.err?"reverted":"success",blockNumber:BigInt(value.slot)};
}
