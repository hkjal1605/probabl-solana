/** Compare shared configuration without exporting database credentials or individual secret values. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

export const sharedDeploymentKeys = [
  "ROBINHOOD_RPC_URL",
  "ROBINHOOD_CHAIN_ID",
  "DATABASE_SCHEMA",
  "DEPLOYMENT_BLOCK",
  "INDEXER_GET_LOGS_BLOCK_RANGE",
  "INDEXER_RPC_MAX_RPS",
  "INDEXER_FINALITY_MODE",
  "INDEXER_CONFIRMATION_MODE",
  "INDEXER_BLOCK_RETENTION",
  "INDEXER_CACHE_RETENTION",
  "CONDITIONAL_TOKENS_ADDRESS",
  "PROTOCOL_AUTHORITY_ADDRESS",
  "MARKET_REGISTRY_ADDRESS",
  "RESOLUTION_CONTROLLER_ADDRESS",
  "EXCHANGE_ADDRESS",
  "SETTLEMENT_ADDRESS",
  "PROTOCOL_FEE_VAULT_ADDRESS",
  "ORDER_VALIDATOR_ADDRESS",
  "ATOMIC_ORDER_ROUTER_ADDRESS",
  "PAYOUT_VAULT_ADDRESS",
  "POSITION_ROUTER_ADDRESS",
  "ORDER_RECOVERY_ROUTER_ADDRESS",
  "MARKET_ADMIN",
  "RESOLUTION_ADMIN",
  "POLYMARKET_INTERNAL_TOKEN",
  "API_AUTH_DOMAIN",
  "API_AUTH_ORIGIN",
  "ADMIN_EVIDENCE_PUBLIC_BASE_URL",
  "DEPLOYMENT_MODE",
  "INTERNAL_MAINNET_RISK_ACK",
].sort();
export function deploymentFingerprint(environment: Record<string, string>, challenge: string) {
  return createHash("sha256")
    .update(challenge)
    .update(JSON.stringify(sharedDeploymentKeys.map((key) => [key, environment[key] ?? ""])))
    .digest("hex");
}
if (import.meta.main) {
  const challenge = process.argv[2];
  if (!challenge || !/^[a-f0-9]{64}$/.test(challenge))
    throw new Error("A fresh comparison challenge is required");
  const environment = parseEnv(readFileSync(resolve(import.meta.dir, "../../.env"), "utf8"));
  console.info(
    JSON.stringify({
      fingerprint: deploymentFingerprint(environment, challenge),
      sharedKeys: sharedDeploymentKeys.length,
      walletKeyPresent: Object.keys(environment).some((key) => key.includes("PRIVATE_KEY")),
      manifest: environment.INDEXER_DEPLOYMENT_MANIFEST?.split("/").at(-1),
      databaseLogin: new URL(environment.DATABASE_URL ?? "").username,
    }),
  );
}
