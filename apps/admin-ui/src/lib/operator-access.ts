import { type Deployment, SolanaClient } from "@conditional-stocks/solana-client";

export function operatorRole(account: string | null, operators: readonly string[] | null) {
  // A missing/failed/in-flight lookup is not an authorization decision.
  if (!account || operators === null) return "unverified" as const;
  return operators.includes(account) ? ("operator" as const) : ("blocked" as const);
}

export async function loadOperators(
  deployment: Deployment,
  createClient: (
    deployment: Deployment,
  ) => Pick<SolanaClient, "assertNetwork" | "configAccount"> = (settings) =>
    new SolanaClient(settings),
) {
  for (const [key, value] of [
    ["NEXT_PUBLIC_SOLANA_CONFIG", deployment.config],
    ["NEXT_PUBLIC_SOLANA_GENESIS_HASH", deployment.genesisHash],
    ["NEXT_PUBLIC_SOLANA_RPC_URL", deployment.rpcUrl],
  ]) {
    if (!value?.trim()) {
      throw new Error(
        `${key} is not configured. Load the public Devnet UI settings in apps/admin-ui/.env.local and restart the admin UI.`,
      );
    }
  }
  const client = createClient(deployment);
  await client.assertNetwork();
  const config = await client.configAccount();
  // Public env address hints never grant access. The SDK checks the account
  // owner and deployment genesis before these on-chain roles are used.
  return [
    config.admin,
    config.roles.market_admin,
    config.roles.resolution_admin,
    config.roles.guardian,
  ].map((address) => address.toBase58());
}
