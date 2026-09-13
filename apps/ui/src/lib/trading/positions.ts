import { SolanaClient,key,type Deployment } from "@conditional-stocks/solana-client";
export async function positionAction(input:{kind:"split"|"merge"|"redeem";marketId:string;collateral:0|1;amount:bigint;branch:0|1;account:string;config:Deployment}) {
  return new SolanaClient(input.config).positionTransaction(input.kind,key(input.marketId),key(input.account),input.collateral,input.amount,input.branch);
}
