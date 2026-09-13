import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type Address, type Hex, keccak256, toBytes } from "viem";
import { releasePolicy } from "../../config/src/release.ts";

export const CTF_RUNTIME_HASH: Hex =
  "0xadf1ee4719c637975ba08765e3a1187f2fb865c9b17386005960a81ff29cfcc7";
export const CTF_CREATION_HASH: Hex =
  "0xc0604e74979d0d1d6d76fd328edad4ff4f45dd18e3c7ca5c8eb7d84dccd3eaf0";

/** Public production is not approved. Mainnet experimentation requires explicit acknowledgement. */
export function assertDevelopmentChain(
  chainId: number,
  environment: Record<string, string | undefined> = Bun.env,
): void {
  releasePolicy(chainId, environment);
}

export function assertRuntime(code: Hex | undefined, expectedHash: Hex, label: string): Hex {
  if (!code || code === "0x" || keccak256(code) !== expectedHash) {
    throw new Error(`${label} runtime does not match the reviewed bytecode`);
  }
  return keccak256(code);
}

export interface BuildMetadata {
  compiler: { version: string };
  settings: {
    evmVersion: string;
    viaIR: boolean;
    optimizer: { enabled: boolean; runs: number };
    metadata: { bytecodeHash: string; appendCBOR: boolean };
  };
  sources: Record<string, { keccak256: Hex }>;
}

export async function assertReviewedBuild(metadata: BuildMetadata): Promise<void> {
  const settings = metadata.settings;
  if (
    metadata.compiler.version !== "0.8.30+commit.73712a01" ||
    settings.evmVersion !== "paris" ||
    settings.viaIR !== true ||
    settings.optimizer.enabled !== true ||
    settings.optimizer.runs !== 7500 ||
    settings.metadata.bytecodeHash !== "none" ||
    settings.metadata.appendCBOR !== false
  )
    throw new Error("Compiler settings differ from the reviewed build");
  for (const [path, source] of Object.entries(metadata.sources)) {
    const actual = keccak256(await readFile(resolve(import.meta.dir, "..", path)));
    if (actual !== source.keccak256) throw new Error(`Stale or altered build source: ${path}`);
  }
}

export async function sourceManifest() {
  const root = resolve(import.meta.dir, "..");
  const paths = (await readdir(resolve(root, "src"), { recursive: true }))
    .filter((path) => path.endsWith(".sol"))
    .sort();
  const files = await Promise.all(
    paths.map(async (path) => ({
      path: `packages/contracts/src/${path}`,
      sha256: createHash("sha256")
        .update(await readFile(resolve(root, "src", path)))
        .digest("hex"),
    })),
  );
  const digest = createHash("sha256")
    .update(files.map((file) => `${file.path} ${file.sha256}\n`).join(""))
    .digest("hex");
  const lockSha256 = createHash("sha256")
    .update(await readFile(resolve(root, "../../bun.lock")))
    .digest("hex");
  return {
    algorithm: "sha256(path + space + sha256 + newline), sorted by path",
    digest,
    files,
    lockSha256,
  };
}

export const roleIds = {
  marketAdmin: keccak256(toBytes("MARKET_ADMIN_ROLE")),
  guardian: keccak256(toBytes("GUARDIAN_ROLE")),
  resolutionAdmin: keccak256(toBytes("RESOLUTION_ADMIN_ROLE")),
} as const;

export function assertDeploymentRoles(
  initialAdmin: Address,
  finalAdmin: Address,
  roles: { guardian: Address; marketAdmin: Address; resolutionAdmin: Address },
) {
  // Market creation and resolution may intentionally share one operator; governance and
  // guardian authority must remain separate from it and from the temporary deployer.
  const separated = [initialAdmin, finalAdmin, roles.guardian, roles.marketAdmin].map((a) =>
    a.toLowerCase(),
  );
  if (
    new Set(separated).size !== 4 ||
    (roles.resolutionAdmin.toLowerCase() !== roles.marketAdmin.toLowerCase() &&
      separated.includes(roles.resolutionAdmin.toLowerCase()))
  )
    throw new Error(
      "Temporary admin, final admin and guardian must be distinct from market operations; only MARKET_ADMIN and RESOLUTION_ADMIN may share a wallet",
    );
}

export interface DeploymentRecord {
  // Only PayoutVault is created by ConditionalExchange rather than by the deployment EOA.
  creator?: Address;
  address: Address;
  blockNumber?: string;
  blockHash?: Hex;
  bytecodeHash: Hex;
  transactionHash?: Hex;
  constructorArgs?: readonly unknown[];
  initcodeHash?: Hex;
}
