import { SolanaClient,key,COLLATERALS,type Deployment } from "@conditional-stocks/solana-client";
/** Split/merge/redeem of one collateral: 0 = quote, 1..=3 = issuer legs. The SDK prepends the idempotent credit initializer. */
export async function positionAction(input:{kind:"split"|"merge"|"redeem";marketId:string;collateral:number;amount:bigint;branch:0|1;account:string;config:Deployment}) {
  if(!Number.isInteger(input.collateral)||input.collateral<0||input.collateral>=COLLATERALS)throw new Error("Invalid collateral");
  return new SolanaClient(input.config).positionTransaction(input.kind,key(input.marketId),key(input.account),input.collateral,input.amount,input.branch);
}
