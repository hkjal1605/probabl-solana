import { cancelOrder } from "@/protocol/engine";
import { type ProtocolTransaction, transaction } from "./transaction";

export type RecoveryKind = "cancel" | "expired" | "invalidated" | "closed";

export async function orderRecovery(input: {
  orderHash: string;
  kind: RecoveryKind;
  account: string;
}): Promise<ProtocolTransaction> {
  return transaction(`${input.kind} order ${input.orderHash}`, () => cancelOrder(input.orderHash));
}
