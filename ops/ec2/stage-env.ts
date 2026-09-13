/** Prepare secret deployment files locally; never copy wallet keys to a backend. */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

const root = resolve(import.meta.dir, "../..");
const target = resolve(root, ".data/deploy/env");
const remoteRoot = "/home/ubuntu/probabl";
const source = parseEnv(readFileSync(resolve(root, ".env"), "utf8"));
const allowed = new Set([
  ...Object.keys(parseEnv(readFileSync(resolve(root, ".env.example"), "utf8"))),
  "DEPLOYMENT_MODE",
  "INTERNAL_MAINNET_RISK_ACK",
  "PONDER_TELEMETRY_DISABLED",
  "DO_NOT_TRACK",
]);
const common = Object.fromEntries(Object.entries(source).filter(([name]) => allowed.has(name)));
if (Object.keys(common).some((name) => /PRIVATE_KEY|NEXT_PUBLIC_|AWS_|CLOUDFLARE_/.test(name)))
  throw new Error("Refusing a non-runtime secret in the deployment environment");
let administrator: URL;
try {
  administrator = new URL(source.DATABASE_URL ?? "");
} catch {
  throw new Error("Invalid DATABASE_URL; its value was not logged");
}
if (
  administrator.hostname !== "probabl.cluster-c3uuueq6kfve.ap-northeast-1.rds.amazonaws.com" ||
  administrator.pathname !== "/postgres" ||
  !administrator.password ||
  administrator.hash
)
  throw new Error("Unexpected deployment database target or missing password");
administrator.searchParams.set("sslmode", "verify-full");
administrator.searchParams.set("sslrootcert", `${remoteRoot}/global-bundle.pem`);
const manifest = source.INDEXER_DEPLOYMENT_MANIFEST;
if (!manifest?.startsWith(`${root}/packages/contracts/deployments/`))
  throw new Error("Expected a deployment manifest inside this repository");
common.INDEXER_DEPLOYMENT_MANIFEST = `${remoteRoot}${manifest.slice(root.length)}`;
common.API_HOST = "127.0.0.1";
common.API_AUTH_DOMAIN = "api.probabl.trade";
common.API_AUTH_ORIGIN = "https://api.probabl.trade";
common.POLYMARKET_HOST = "127.0.0.1";
common.PONDER_TELEMETRY_DISABLED = "true";
common.DO_NOT_TRACK = "1";

mkdirSync(target, { recursive: true, mode: 0o700 });
chmodSync(target, 0o700);
const credentials: Record<string, string> = {};
for (const name of ["api", "indexer", "reconciler", "polymarket"]) {
  const path = resolve(target, name === "api" ? ".env" : `.env.${name}`);
  if (existsSync(path))
    throw new Error("Staged environment already exists; preserve its credentials");
  const url = new URL(administrator);
  url.username = `probabl_${name}`;
  url.password = randomBytes(32).toString("hex");
  credentials[name] = url.toString();
}
common.DATABASE_URL = credentials.api;
const serialize = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([key, value]) => {
      if (/[\r\n$]/.test(value)) throw new Error(`Encode special characters before staging ${key}`);
      return `${key}=${JSON.stringify(value)}`;
    })
    .join("\n");
const files = {
  ".env": serialize(common),
  ".env.indexer": serialize({ DATABASE_URL: credentials.indexer }),
  ".env.reconciler": serialize({ DATABASE_URL: credentials.reconciler }),
  ".env.polymarket": serialize({ DATABASE_URL: credentials.polymarket }),
  ".env.bootstrap": serialize({ DATABASE_URL: administrator.toString() }),
};
for (const name of Object.keys(files))
  if (existsSync(resolve(target, name))) throw new Error("Refusing to overwrite staged secrets");
const patch = [
  "*** Begin Patch",
  ...Object.entries(files).flatMap(([name, content]) => [
    `*** Add File: .data/deploy/env/${name}`,
    ...content.split("\n").map((line) => `+${line}`),
  ]),
  "*** End Patch",
  "",
].join("\n");
// Secret values stay in memory/stdin, never process arguments or terminal output.
try {
  execFileSync("apply_patch", [], { input: patch, cwd: root, stdio: ["pipe", "pipe", "pipe"] });
} catch {
  throw new Error("Secret-file staging failed; patch diagnostics were withheld");
}
for (const name of Object.keys(files)) chmodSync(resolve(target, name), 0o600);
console.log(
  JSON.stringify({ staged: Object.keys(files), walletKeysIncluded: false, fileMode: "0600" }),
);
