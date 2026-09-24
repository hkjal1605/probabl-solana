/** Installs the Yellowstone gRPC Geyser plugin matching the pinned Agave
 * release and writes a validator plugin config for local development and CI.
 *
 *   bun scripts/solana/yellowstone.ts [--port 10000] [--out .local/yellowstone]
 *
 * Linux x86_64 downloads the checksum-pinned release build. macOS builds the
 * pinned tag from source (upstream pins thread affinity, which is Linux-only;
 * `yellowstone/macos-affinity.patch` gates it). The printed flag goes on
 * `solana-test-validator`; services read `YELLOWSTONE_GRPC_URL`. */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { arch, platform } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

export const YELLOWSTONE_TAG = "v12.1.0+solana.3.1.10";
const RELEASE = {
  asset: "yellowstone-grpc-geyser-release24-x86_64-unknown-linux-gnu.tar.bz2",
  sha256: "3a7b8fd5f9ced564a472ad16a1ef76b477880d3443fb37e0512394e9fd6eb5e5",
};

/** Plugin config: replay retention covers reconnects (the index resumes from
 * its last finalized slot) and loopback-only binding keeps it local. */
export function geyserConfig(libpath: string, port: number) {
  return {
    libpath,
    log: { level: "info" },
    grpc: {
      address: `127.0.0.1:${port}`,
      max_decoding_message_size: "4_194_304",
      snapshot_client_channel_capacity: "50_000_000",
      channel_capacity: "100_000",
      unary_concurrency_limit: 100,
      unary_disabled: false,
      x_token: null,
      replay_stored_slots: 2000,
      filter_name_size_limit: 128,
      filter_names_size_limit: 4096,
      filter_names_cleanup_interval: "1s",
    },
  };
}

async function run(command: string[], cwd?: string) {
  const child = Bun.spawn(command, { ...(cwd ? { cwd } : {}), stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error("Command failed: " + command.join(" "));
}

async function linuxRelease(directory: string) {
  const library = join(directory, "lib", "libyellowstone_grpc_geyser.so");
  if (existsSync(library)) return library;
  const url = `https://github.com/rpcpool/yellowstone-grpc/releases/download/${encodeURIComponent(YELLOWSTONE_TAG)}/${RELEASE.asset}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (digest !== RELEASE.sha256) throw new Error(`Checksum mismatch for ${RELEASE.asset}: ${digest}`);
  const archive = join(directory, RELEASE.asset);
  await Bun.write(archive, bytes);
  await run(["tar", "-xjf", archive, "-C", directory]);
  const found = new Bun.Glob("**/libyellowstone_grpc_geyser.so").scanSync({ cwd: directory, absolute: true }).next().value;
  if (!found) throw new Error("Release archive has no libyellowstone_grpc_geyser.so");
  await mkdir(join(directory, "lib"), { recursive: true });
  if (found !== library) await Bun.write(library, Bun.file(found));
  return library;
}

async function sourceBuild(directory: string) {
  const source = join(directory, "yellowstone-grpc");
  const library = join(source, "target", "release", "libyellowstone_grpc_geyser.dylib");
  if (existsSync(library)) return library;
  if (!existsSync(source))
    await run(["git", "clone", "--depth", "1", "--branch", YELLOWSTONE_TAG, "https://github.com/rpcpool/yellowstone-grpc.git", source]);
  const patch = resolve(import.meta.dir, "yellowstone", "macos-affinity.patch");
  // Idempotent: skip when a previous run already applied it.
  const applied = Bun.spawnSync(["git", "apply", "--reverse", "--check", patch], { cwd: source }).exitCode === 0;
  if (!applied) await run(["git", "apply", patch], source);
  await run(["cargo", "build", "--release", "--locked", "-p", "yellowstone-grpc-geyser"], source);
  return library;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { port: { type: "string", default: "10000" }, out: { type: "string", default: ".local/yellowstone" } },
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid --port");
  const directory = resolve(values.out!);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let library: string;
  if (platform() === "linux" && arch() === "x64") library = await linuxRelease(directory);
  else if (platform() === "darwin") library = await sourceBuild(directory);
  else throw new Error(`No Yellowstone build recipe for ${platform()}/${arch()}`);
  const config = join(directory, `geyser-${port}.json`);
  await Bun.write(config, JSON.stringify(geyserConfig(library, port), null, 2) + "\n");
  console.info(`--geyser-plugin-config ${config}`);
  console.info(`YELLOWSTONE_GRPC_URL=http://127.0.0.1:${port}`);
}
