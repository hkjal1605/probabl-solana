import { SolanaClient,parseOrder,parseAtomicPlan,orderId,envelope,verifyEnvelope,address,key,ASSETS,PublicKey,underlyingAsset,type Deployment } from "@conditional-stocks/solana-client";
/** Indexed market context for placement: all 12 asset mints (underlying 3c, YES 3c+1, NO 3c+2). */
export function marketMints(market:{claimMints:readonly string[];quoteToken:string;bases:readonly {collateral:number;mint:string}[]}){
  if(!Array.isArray(market.claimMints)||market.claimMints.length!==ASSETS)throw new Error("Indexed market mint table is incomplete");
  // Unlisted legs are the default key in the table; every listed entry must be a canonical key.
  const mints=market.claimMints.map(mint=>mint===PublicKey.default.toBase58()?PublicKey.default:key(address(mint)));
  if(mints[0]!.toBase58()!==market.quoteToken)throw new Error("Indexed quote mint differs from the market");
  for(const leg of market.bases)if(mints[underlyingAsset(leg.collateral)]!.toBase58()!==leg.mint)throw new Error("Indexed issuer mint differs from the market");
  return mints;
}
export function atomicTransaction(input:{order:unknown;plan:unknown;account:string;config:Deployment;market:{claimMints:readonly string[];quoteToken:string;bases:readonly {collateral:number;mint:string}[]};nowSeconds?:bigint}){
  address(input.config.config);address(input.config.genesisHash);
  const order=parseOrder(input.order),plan=parseAtomicPlan(input.plan,order),now=input.nowSeconds??BigInt(Math.floor(Date.now()/1000));
  if(order.maker!==input.account)throw new Error("Order wallet changed");
  if(BigInt(plan.deadline)<=now||BigInt(plan.deadline)>now+65n)throw new Error("Quote expired or has an invalid deadline; review again");
  const client=new SolanaClient(input.config);
  return {orderHash:orderId(order,client.program),transaction:envelope([client.placement(order,plan,{config:client.config,mints:marketMints(input.market)})],client.program)};
}
export function verifyAtomicResponse(expected:ReturnType<typeof atomicTransaction>,response:unknown){
  const value=response as {orderHash?:string;executionVersion?:number}|null;
  if(value?.orderHash!==expected.orderHash||value?.executionVersion!==1)throw new Error("API transaction does not match the reviewed order");
  return verifyEnvelope(expected.transaction,response);
}
