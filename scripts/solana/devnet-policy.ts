import { createHash } from "node:crypto";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
  type AccountInfo,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
} from "@solana/spl-token";
import { PROGRAM_ID, configAddress } from "@conditional-stocks/solana-client";

// Pinned to the official Devnet RPC, checked 2026-09-12. No env override.
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const DEVNET_RPC = "https://api.devnet.solana.com";
export const LOADER = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);
export const sha256 = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");
export const ASSETS = [
  { symbol: "USDC", decimals: 6, units: "1000000", kind: "spl", feeBps: 0 },
  { symbol: "BTC", decimals: 8, units: "1000", kind: "spl", feeBps: 0 },
  { symbol: "ETH", decimals: 9, units: "10000", kind: "spl", feeBps: 0 },
  { symbol: "SOL", decimals: 9, units: "0.1", kind: "native", feeBps: 0 },
  { symbol: "TSLA", decimals: 6, units: "10000", kind: "token2022", feeBps: 0 },
  {
    symbol: "NVDA",
    decimals: 6,
    units: "10000",
    kind: "token2022",
    feeBps: 25,
  },
  { symbol: "SPY", decimals: 6, units: "10000", kind: "token2022", feeBps: 0 },
] as const;
export type AssetSpec = (typeof ASSETS)[number];
export function rawAmount(units: string, decimals: number): bigint {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 18 ||
    !/^(0|[1-9]\d*)(\.\d+)?$/.test(units)
  )
    throw new Error("Invalid raw-unit amount");
  const [whole, fraction = ""] = units.split(".");
  if (fraction.length > decimals)
    throw new Error("Amount exceeds mint precision");
  const value =
    BigInt(whole!) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0");
  if (value <= 0n || value > (1n << 64n) - 1n)
    throw new Error("Amount outside positive u64");
  return value;
}
export const tokenProgram = (asset: AssetSpec) =>
  asset.kind === "token2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
export function parseDeployer(value: string | undefined): Keypair {
  try {
    if (!value?.trim()) throw new Error();
    const input = value.trim();
    const parsed: unknown = input.startsWith("[")
      ? JSON.parse(input)
      : [...bs58.decode(input)];
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 64 ||
      parsed.some((b) => !Number.isInteger(b) || b < 0 || b > 255)
    )
      throw new Error();
    return Keypair.fromSecretKey(Uint8Array.from(parsed));
  } catch {
    // Never include the input, parser error, or key material in an exception.
    throw new Error(
      "DEVNET_DEPLOYER_PRIVATE_KEY must be a valid base58 or JSON 64-byte Solana secret key",
    );
  }
}
export function devnetRpc(value = DEVNET_RPC): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new Error();
    return url.toString();
  } catch {
    throw new Error("Devnet RPC must be HTTPS without userinfo or fragment");
  }
}
export async function assertDevnet(
  connection: Pick<Connection, "getGenesisHash">,
): Promise<void> {
  if ((await connection.getGenesisHash()) !== DEVNET_GENESIS)
    throw new Error(
      "Refusing non-Devnet genesis; no transactions were authorized",
    );
}
export function readProgram(
  program: AccountInfo<Buffer> | null,
): PublicKey | null {
  if (!program) return null;
  if (
    !program.owner.equals(LOADER) ||
    !program.executable ||
    program.data.length !== 36 ||
    program.data.readUInt32LE(0) !== 2
  )
    throw new Error(
      "Existing program is not a canonical upgradeable-loader program",
    );
  return new PublicKey(program.data.subarray(4));
}
export function verifyBuffer(
  info: AccountInfo<Buffer> | null,
  artifactBytes: number,
  authority: PublicKey,
) {
  if (!info) return 0;
  if (
    !info.owner.equals(LOADER) ||
    info.executable ||
    info.data.length !== artifactBytes + 37 ||
    info.data.readUInt32LE(0) !== 1 ||
    info.data[4] !== 1 ||
    !new PublicKey(info.data.subarray(5, 37)).equals(authority) ||
    !Number.isSafeInteger(info.lamports) ||
    info.lamports < 0
  )
    throw new Error(
      "Resumable deployment buffer identity, size or authority differs",
    );
  return info.lamports;
}
export function uploadTransport(rpc: string, configured?: string): string[] {
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(
    new URL(rpc).hostname,
  );
  const transport = configured ?? (local ? "rpc" : "tpu");
  if (transport === "rpc" || transport === "rpc-paced") return ["--use-rpc"];
  if (transport === "tpu") return ["--use-tpu-client", "--use-quic"];
  throw new Error("DEVNET_UPLOAD_TRANSPORT must be tpu, rpc or rpc-paced");
}
export function verifyProgramData(
  info: AccountInfo<Buffer> | null,
  artifact: Buffer,
  authority: PublicKey,
) {
  if (
    !info ||
    !info.owner.equals(LOADER) ||
    info.executable ||
    info.data.length < 45 ||
    info.data.readUInt32LE(0) !== 3 ||
    info.data[12] !== 1 ||
    !new PublicKey(info.data.subarray(13, 45)).equals(authority)
  )
    throw new Error(
      "Unexpected program data or upgrade authority; refusing adoption/upgrade",
    );
  const bytes = info.data.subarray(45);
  if (
    bytes.length < artifact.length ||
    !bytes.subarray(0, artifact.length).equals(artifact) ||
    bytes.subarray(artifact.length).some((b) => b !== 0)
  )
    throw new Error(
      "Deployed executable differs from the prepared artifact; automatic upgrades are prohibited",
    );
  return {
    slot: info.data.readBigUInt64LE(4).toString(),
    bytes: artifact.length,
    sha256: sha256(artifact),
  };
}
export interface AssetPlan {
  symbol: AssetSpec["symbol"];
  mint: string;
  ata: string;
  program: string;
  decimals: number;
  initialRaw: string;
  name: string;
  metadataSymbol: string;
  feeBps: number;
}
export interface DeploymentPlan {
  version: 1;
  cluster: "devnet";
  genesisHash: string;
  programId: string;
  deployer: string;
  config: string;
  artifactSha256: string;
  artifactBytes: number;
  idlSha256: string;
  sourceSha256: Record<string, string>;
  assets: AssetPlan[];
}
export function validatePlanIdentity(plan: DeploymentPlan, owner: PublicKey) {
  if (
    plan.version !== 1 ||
    plan.cluster !== "devnet" ||
    plan.genesisHash !== DEVNET_GENESIS ||
    plan.programId !== PROGRAM_ID.toBase58() ||
    plan.deployer !== owner.toBase58() ||
    plan.config !== configAddress(owner).toBase58() ||
    plan.assets.length !== ASSETS.length
  )
    throw new Error(
      "Prepared deployment identity differs; do not reuse another deployment directory",
    );
}
export { PROGRAM_ID, NATIVE_MINT };
