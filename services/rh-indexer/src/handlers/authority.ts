import { persistProtocolEvent } from "@conditional-stocks/db/indexer/writes";
import { ponder } from "../observability.ts";

for (const eventName of [
  "DefaultAdminDelayChangeCanceled",
  "DefaultAdminDelayChangeScheduled",
  "DefaultAdminTransferCanceled",
  "DefaultAdminTransferScheduled",
  "RoleAdminChanged",
  "RoleGranted",
  "RoleRevoked",
] as const) {
  ponder.on(`ProtocolAuthority:${eventName}`, async ({ event, context }) => {
    await persistProtocolEvent(context.db, context.chain.id, "ProtocolAuthority", eventName, event);
  });
}
