import { expect,test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { coder,unwrap,PROGRAM_ID } from "@conditional-stocks/solana-client";
import { payoutWithdrawal,verifyPayoutResponse } from "../src/lib/trading/payouts";
const account=PublicKey.unique().toBase58(),recipient=PublicKey.unique().toBase58(),marketId=PublicKey.unique().toBase58(),asset=PublicKey.unique().toBase58();
const config={rpcUrl:"http://127.0.0.1:8899",config:PublicKey.unique().toBase58(),genesisHash:"test"};
const credit={beneficiary:account,asset,marketId,tokenId:"2",amount:"100"};
test("SPL withdrawal commits exact amount, beneficiary PDA, mint and receiving account",()=>{
 const tx=payoutWithdrawal({credit,amount:50n,recipient,account,config});
 const instructions=unwrap(tx);
 expect(instructions[1]!.programId.equals(PROGRAM_ID)).toBe(true);
 const decoded=coder.instruction.decode(instructions[1]!.data)!;
 expect(decoded.name).toBe("withdraw");
 expect(String((decoded.data as {amount:unknown}).amount)).toBe("50");
 expect(verifyPayoutResponse(tx,{transaction:tx})).toBe(tx);
 for(const change of [{to:recipient},{data:"AA=="},{value:"1"}])expect(()=>verifyPayoutResponse(tx,{transaction:{...tx,...change}})).toThrow();
 for(const amount of [0n,-1n,101n])expect(()=>payoutWithdrawal({credit,amount,recipient,account,config})).toThrow();
 expect(()=>payoutWithdrawal({credit,amount:1n,recipient,account:recipient,config})).toThrow();
});
