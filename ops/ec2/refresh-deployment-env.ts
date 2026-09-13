/** Apply a verified fresh manifest to local and staged EC2 envs without logging secrets. */
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

const root = resolve(import.meta.dir, "../..");
const manifestPath = resolve(process.argv[2] ?? "");
const remoteEnvPath = resolve(process.argv[3] ?? "");
if (
  !manifestPath.startsWith(`${root}/packages/contracts/deployments/4663/`) ||
  !remoteEnvPath.startsWith(`${root}/.data/deploy/`)
)
  throw new Error("Expected a local manifest and gitignored staged server env");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  chainId: number;
  productionApproved: boolean;
  protocolVersion: number;
  roles: { marketAdmin: string; resolutionAdmin: string };
  deployments: Record<string, { address: string; blockNumber: string }>;
};
if (
  manifest.chainId !== 4663 ||
  manifest.productionApproved !== false ||
  manifest.protocolVersion !== 2 ||
  manifest.roles.marketAdmin !== manifest.roles.resolutionAdmin
)
  throw new Error("Unexpected deployment manifest");
const mapping = {
  CONDITIONAL_TOKENS_ADDRESS: "ConditionalTokens",
  PROTOCOL_AUTHORITY_ADDRESS: "ProtocolAuthority",
  MARKET_REGISTRY_ADDRESS: "MarketRegistry",
  RESOLUTION_CONTROLLER_ADDRESS: "ManualResolutionController",
  EXCHANGE_ADDRESS: "ConditionalExchange",
  SETTLEMENT_ADDRESS: "ConditionalSettlement",
  PROTOCOL_FEE_VAULT_ADDRESS: "ProtocolFeeVault",
  ORDER_VALIDATOR_ADDRESS: "OrderValidator",
  ATOMIC_ORDER_ROUTER_ADDRESS: "AtomicOrderRouter",
  PAYOUT_VAULT_ADDRESS: "PayoutVault",
  POSITION_ROUTER_ADDRESS: "PositionRouter",
  ORDER_RECOVERY_ROUTER_ADDRESS: "OrderRecoveryRouter",
};
const common: Record<string, string> = Object.fromEntries(
  Object.entries(mapping).map(([key, name]) => {
    const address = manifest.deployments[name]?.address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? "")) throw new Error(`Missing ${name}`);
    return [key, address];
  }),
);
Object.assign(common, {
  DEPLOYMENT_BLOCK: Math.min(
    ...Object.values(manifest.deployments).map((record) => Number(record.blockNumber)),
  ).toString(),
  DATABASE_SCHEMA: "probabl_indexer_20260910",
  INDEXER_GET_LOGS_BLOCK_RANGE: "10",
  INDEXER_RPC_MAX_RPS: "26",
  MARKET_ADMIN: manifest.roles.marketAdmin,
  RESOLUTION_ADMIN: manifest.roles.resolutionAdmin,
  MARKET_ADMIN_SAFE_ADDRESS: manifest.roles.marketAdmin,
  RESOLUTION_ADMIN_SAFE_ADDRESS: manifest.roles.resolutionAdmin,
});
if (!Number.isSafeInteger(Number(common.DEPLOYMENT_BLOCK)) || Number(common.DEPLOYMENT_BLOCK) <= 0)
  throw new Error("Invalid first deployment block");
const local = parseEnv(readFileSync(resolve(root, ".env"), "utf8"));
const localUpdates = {
  ...common,
  DEPLOYMENT_MANIFEST: manifestPath,
  INDEXER_DEPLOYMENT_MANIFEST: manifestPath,
  NEXT_PUBLIC_RESOLUTION_CONTROLLER_ADDRESS: common.RESOLUTION_CONTROLLER_ADDRESS,
  NEXT_PUBLIC_MARKET_ADMIN_ADDRESS: common.MARKET_ADMIN,
  ...Object.fromEntries(
    Object.entries(common)
      .filter(([key]) => key.endsWith("_ADDRESS") && `NEXT_PUBLIC_${key}` in local)
      .map(([key, value]) => [`NEXT_PUBLIC_${key}`, value]),
  ),
};
const allowed = new Set(Object.keys(parseEnv(readFileSync(resolve(root, ".env.example"), "utf8"))));
for (const key of [
  ...Object.keys(common),
  "DEPLOYMENT_MODE",
  "INTERNAL_MAINNET_RISK_ACK",
  "PONDER_TELEMETRY_DISABLED",
  "DO_NOT_TRACK",
])
  allowed.add(key);
const remoteUpdates: Record<string, string> = Object.fromEntries(
  Object.entries({ ...local, ...localUpdates }).filter(
    ([key]) =>
      allowed.has(key) &&
      key !== "DATABASE_URL" &&
      !/PRIVATE_KEY|NEXT_PUBLIC_|AWS_|CLOUDFLARE_/.test(key),
  ),
);
remoteUpdates.INDEXER_DEPLOYMENT_MANIFEST = `/home/ubuntu/probabl${manifestPath.slice(root.length)}`;
if ("DEPLOYMENT_MANIFEST" in remoteUpdates)
  remoteUpdates.DEPLOYMENT_MANIFEST = remoteUpdates.INDEXER_DEPLOYMENT_MANIFEST;

function patchEnv(path: string, updates: Record<string, string>) {
  const before = readFileSync(path, "utf8").trimEnd();
  const remaining = new Map(Object.entries(updates));
  const lines = before.split("\n").map((line) => {
    const key = line.match(/^([A-Z0-9_]+)=/)?.[1];
    if (!key || !remaining.has(key)) return line;
    const value = remaining.get(key);
    remaining.delete(key);
    return `${key}=${JSON.stringify(value)}`;
  });
  for (const [key, value] of remaining) lines.push(`${key}=${JSON.stringify(value)}`);
  const patch = [
    "*** Begin Patch",
    `*** Update File: ${path}`,
    "@@",
    ...before.split("\n").map((line) => `-${line}`),
    ...lines.map((line) => `+${line}`),
    "*** End Patch",
    "",
  ].join("\n");
  try {
    execFileSync("apply_patch", [], { input: patch, cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    throw new Error("Environment patch failed; secret diagnostics withheld");
  }
  chmodSync(path, 0o600);
}
patchEnv(resolve(root, ".env"), localUpdates);
patchEnv(remoteEnvPath, remoteUpdates);
console.info(
  JSON.stringify({
    updated: ["local .env", "staged EC2 .env"],
    chainId: 4663,
    deploymentBlock: common.DEPLOYMENT_BLOCK,
    exchange: common.EXCHANGE_ADDRESS,
    schema: common.DATABASE_SCHEMA,
    databaseCredentialsPreserved: true,
    walletKeysCopied: false,
  }),
);
