import { envelope,key,verifyEnvelope } from "@conditional-stocks/solana-client";
import { solana } from "./rpc";
export type RecoveryKind="cancel"|"expired"|"invalidated"|"closed";
export async function orderRecovery(input:{orderHash:string;kind:RecoveryKind;account:string;config:unknown}) {
  const client=solana();return envelope([await client.cancel(key(input.orderHash),key(input.account))],client.program);
}
export const verifyRecoveryResponse=verifyEnvelope;
