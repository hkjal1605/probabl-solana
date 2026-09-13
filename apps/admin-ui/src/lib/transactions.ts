import { SolanaClient } from "@conditional-stocks/solana-client";
import { evidenceTransaction as buildTransaction,preflightAdmin,type AdminDeployment } from "@conditional-stocks/solana-client/admin";
import { adminConfig } from "@/config/protocol";
import type { AdminPreview,EvidenceView } from "./admin-api";
export function evidenceTransaction(view:EvidenceView,action:AdminPreview["action"],config:AdminDeployment=adminConfig){
  if(view.status!=="approved"||view.reviews.at(-1)?.decision!=="approve")throw new Error("Explicit market-admin approval is required");
  return buildTransaction(view.envelope,action,config);
}
export function verifyAdminPreview(view:EvidenceView,preview:AdminPreview,config:AdminDeployment=adminConfig){
  const expected=evidenceTransaction(view,preview.action,config);
  if(preview.packetHash!==view.envelope.packetHash||preview.expectedMarketId!==expected.expectedMarketId
    ||preview.chainId!==expected.chainId||preview.from!==expected.from||preview.to!==expected.to||preview.data!==expected.data||preview.value!=="0")
    throw new Error("API transaction differs from the approved evidence and Solana deployment");
  return expected;
}
export const preflightTransaction=(transaction:Parameters<typeof preflightAdmin>[1])=>preflightAdmin(new SolanaClient(adminConfig),transaction);
export async function waitForAdminReceipt(signature:string){
  const client=new SolanaClient(adminConfig);await client.assertNetwork();
  const result=await client.connection.getSignatureStatuses([signature],{searchTransactionHistory:true}),status=result.value[0];
  if(!status||status.err||!["confirmed","finalized"].includes(status.confirmationStatus??""))throw new Error("Successful transaction confirmation is not available");
  return status;
}
