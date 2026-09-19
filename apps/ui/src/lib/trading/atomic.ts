import { SolanaClient,parseOrder,parseAtomicPlan,orderId,envelope,verifyEnvelope,address,key,type Deployment } from "@conditional-stocks/solana-client";
export function atomicTransaction(input:{order:unknown;plan:unknown;account:string;config:Deployment;market:{baseToken:string;quoteToken:string};nowSeconds?:bigint}){
  address(input.config.config);address(input.config.genesisHash);
  const order=parseOrder(input.order),plan=parseAtomicPlan(input.plan,order),now=input.nowSeconds??BigInt(Math.floor(Date.now()/1000));
  if(order.maker!==input.account)throw new Error("Order wallet changed");
  if(BigInt(plan.deadline)<=now||BigInt(plan.deadline)>now+65n)throw new Error("Quote expired or has an invalid deadline; review again");
  const client=new SolanaClient(input.config);
  return {orderHash:orderId(order,client.program),transaction:envelope([client.placement(order,plan,{config:client.config,mints:[key(address(input.market.baseToken)),key(address(input.market.quoteToken))]})],client.program)};
}
export function verifyAtomicResponse(expected:ReturnType<typeof atomicTransaction>,response:unknown){
  const value=response as {orderHash?:string;executionVersion?:number}|null;
  if(value?.orderHash!==expected.orderHash||value?.executionVersion!==1)throw new Error("API transaction does not match the reviewed order");
  return verifyEnvelope(expected.transaction,response);
}
