import { constants } from "node:fs";
import {
  open,
  mkdir,
  lstat,
  realpath,
  rename,
  unlink,
  rmdir,
  mkdtemp,
} from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { tmpdir } from "node:os";
import { Keypair } from "@solana/web3.js";
import { parseDeployer } from "./devnet-policy.ts";

export async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
    throw new Error(
      "Deployment directory must be a private (0700), non-symlink directory",
    );
}
export async function deploymentDirectory(value = ".local/devnet") {
  const base = resolve(".local"),
    path = resolve(value);
  if (!path.startsWith(base + sep))
    throw new Error(
      "Deployment output must be a child of the repository .local directory",
    );
  await mkdir(base, { recursive: true, mode: 0o700 });
  if ((await lstat(base)).isSymbolicLink())
    throw new Error("Refusing symlink .local directory");
  await privateDirectory(path);
  if (!(await realpath(path)).startsWith((await realpath(base)) + sep))
    throw new Error("Deployment path escapes .local");
  return path;
}
export async function readJson<T>(path: string): Promise<T | null> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Cannot safely read deployment file");
  }
  try {
    if (!(await file.stat()).isFile())
      throw new Error("Deployment state must be a regular file");
    try {
      return JSON.parse(await file.readFile("utf8")) as T;
    } catch {
      throw new Error("Invalid deployment JSON; file contents suppressed");
    }
  } finally {
    await file.close();
  }
}
export async function writeJson(path: string, value: unknown) {
  await writePrivate(path, JSON.stringify(value, null, 2) + "\n");
}
export async function writePrivate(path: string, value: string) {
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new Error("Refusing symlink output");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const temp = path + "." + crypto.randomUUID() + ".tmp";
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(value);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
}
export async function keyFile(path: string, create: boolean): Promise<Keypair> {
  let saved = await readJson<unknown>(path);
  if (saved === null && create) {
    const signer = Keypair.generate();
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify([...signer.secretKey]));
      await file.sync();
    } finally {
      await file.close();
    }
    saved = [...signer.secretKey];
  }
  if (saved === null)
    throw new Error(
      "Required program/mint signer file is missing; do not generate a different program ID",
    );
  return parseDeployer(JSON.stringify(saved));
}
export async function locked<T>(directory: string, action: () => Promise<T>) {
  const path = join(directory, "pipeline.lock");
  let file;
  try {
    file = await open(path, "wx", 0o600);
  } catch {
    throw new Error(
      "Deployment is locked; check the recorded process before recovering a stale pipeline.lock",
    );
  }
  try {
    await file.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    return await action();
  } finally {
    await file.close();
    await unlink(path);
  }
}
export async function withTemporarySigner<T>(
  signer: Keypair,
  action: (path: string) => Promise<T>,
) {
  const directory = await mkdtemp(join(tmpdir(), "probabl-devnet-signer-"));
  const path = join(directory, "signer.json");
  try {
    await writeJson(path, [...signer.secretKey]);
    return await action(path);
  } finally {
    await unlink(path).catch(() => {});
    await rmdir(directory);
  }
}
