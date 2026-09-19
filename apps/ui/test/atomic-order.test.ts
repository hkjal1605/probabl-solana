import { test,expect } from "bun:test";
import { PublicKey,PROGRAM_ID,planOrder,coder,unwrap } from "@conditional-stocks/solana-client";
import { atomicTransaction,verifyAtomicResponse } from "../src/lib/trading/atomic";
const pubkey=()=>PublicKey.unique().toBase58(),account=pubkey();
const config={rpcUrl:"http://127.0.0.1:8899",config:pubkey(),genesisHash:pubkey(),programId:PROGRAM_ID.toBase58()};
const order={maker:account,recipient:account,marketId:pubkey(),salt:"0x"+"22".repeat(32),quantity:"1000000",
  limitPriceRawX18:"5000000000000000000",expiry:"2000",nonce:"1",maxFeeBps:0,branch:0,side:0,fundingKind:0,tif:0};
const plan=planOrder({order,candidates:[],now:1500n,step:1n,nextSequence:0n,makerFeeBps:0,takerFeeBps:0}),input={order,plan,account,config,market:{baseToken:pubkey(),quoteToken:pubkey()},nowSeconds:1500n};
test("native atomic order binds signer, PDA, raw terms and reviewed plan",()=>{
  const expected=atomicTransaction(input),ix=unwrap(expected.transaction)[0]!,decoded=coder.instruction.decode(ix.data)!;
  expect(decoded.name).toBe("place");expect(ix.keys[0]!.pubkey.toBase58()).toBe(account);expect(ix.keys[0]!.isSigner).toBe(true);
  expect(verifyAtomicResponse(expected,{...expected,executionVersion:1})).toEqual(expected.transaction);
});
test("the API cannot change the Solana destination, instruction bytes, value, order PDA or execution version",()=>{
  const expected=atomicTransaction(input);
  for(const changes of [{to:pubkey()},{data:"bad"},{value:"1"},{value:0}])
    expect(()=>verifyAtomicResponse(expected,{...expected,executionVersion:1,transaction:{...expected.transaction,...changes}})).toThrow();
  for(const changes of [{orderHash:pubkey()},{executionVersion:2},{transaction:null}])
    expect(()=>verifyAtomicResponse(expected,{...expected,executionVersion:1,...changes})).toThrow();
});
test("expiry, stale wallet, missing deployment, malformed amounts and unsupported maker plans fail before signing",()=>{
  expect(()=>atomicTransaction({...input,nowSeconds:1560n})).toThrow("expired");
  expect(()=>atomicTransaction({...input,nowSeconds:1494n})).toThrow("deadline");
  expect(()=>atomicTransaction({...input,account:pubkey()})).toThrow("wallet");
  expect(()=>atomicTransaction({...input,config:{...config,config:""}})).toThrow();
  expect(()=>atomicTransaction({...input,order:{...order,quantity:1000000}})).toThrow();
  expect(()=>atomicTransaction({...input,plan:{...plan,quantities:["1"]}})).toThrow();
});
