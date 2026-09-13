import { parseTokenAmount } from "@conditional-stocks/domain";
import { key } from "@conditional-stocks/solana-client";
import { solana } from "./rpc";
export async function walletTransfer(input:{token:string;recipient:string;amount:string;decimals:number;account:string}) {
  const amount=parseTokenAmount(input.amount.trim(),input.decimals);
  if(amount<=0n||amount>=1n<<64n)throw new Error("Invalid SPL transfer amount");
  return solana().transfer(key(input.account),key(input.token),key(input.recipient),amount);
}
