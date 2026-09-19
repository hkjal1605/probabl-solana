/** Local only. Stage an explicit backend allowlist; never ship the deployer key. */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

const root = resolve(import.meta.dir, "../../..");
const remoteRoot = "/home/ubuntu/probabl-solana";
const target = resolve(root, ".local/ec2/env");
const source = parseEnv(readFileSync(resolve(root, ".env.devnet"), "utf8"));
const deployed = parseEnv(
  readFileSync(resolve(root, ".local/devnet/backend.env"), "utf8"),
);
const administrator = new URL(source.DATABASE_URL ?? "");
if (
  administrator.hostname !==
    "probabl-solana-db.cluster-c3uuueq6kfve.ap-northeast-1.rds.amazonaws.com" ||
  administrator.pathname !== "/postgres" ||
  administrator.username !== "postgres" ||
  !administrator.password ||
  /enter|placeholder/i.test(administrator.password) ||
  administrator.hash
)
  throw new Error(
    "Unexpected database target or missing password (value withheld)",
  );
administrator.port = "5432";
administrator.searchParams.set("sslmode", "verify-full");
administrator.searchParams.set(
  "sslrootcert",
  `${remoteRoot}/certs/rds-ap-northeast-1-bundle.pem`,
);

const common: Record<string, string> = { NODE_ENV: "production" };
for (const name of [
  "SOLANA_RPC_URL",
  "SOLANA_PROGRAM_ID",
  "SOLANA_CONFIG",
  "SOLANA_GENESIS_HASH",
])
  common[name] = deployed[name] ?? "";
if (
  common.SOLANA_GENESIS_HASH !==
    "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" ||
  common.SOLANA_CONFIG !== "6buYkVtSJjaoozCDsPFYrPhp5g1q1oLg2eLp7FpsZ1tF" ||
  common.SOLANA_PROGRAM_ID !== "8S7LwM6yRszZaAoEQqgE1AYcZJLpyVVC5MRr7vqCxLtg"
)
  throw new Error("Unexpected Solana devnet deployment");

mkdirSync(target, { recursive: true, mode: 0o700 });
chmodSync(target, 0o700);
const files: Record<string, Record<string, string>> = {
  "bootstrap.env": { ...common, DATABASE_URL: administrator.toString() },
};
const internalToken = randomBytes(32).toString("hex");
for (const service of ["api", "indexer", "polymarket"]) {
  const url = new URL(administrator);
  url.username = `probabl_sol_${service}`;
  url.password = randomBytes(32).toString("hex");
  const values = { ...common, DATABASE_URL: url.toString() };
  files[`${service}.env`] = values;
}
Object.assign(files["api.env"]!, {
  API_HOST: "127.0.0.1",
  API_PORT: "3000",
  INDEXER_URL: "http://127.0.0.1:42069",
  API_AUTH_ORIGINS:
    "http://localhost:3001,http://localhost:3002,http://127.0.0.1:3001,http://127.0.0.1:3002",
  POLYMARKET_INGESTOR_URL: "http://127.0.0.1:42073",
  POLYMARKET_INTERNAL_TOKEN: internalToken,
  REDIS_URL: source.REDIS_URL ?? "redis://127.0.0.1:6379",
  // Pricing provider credentials belong only to the API, never UI/indexer/ingestor.
  ...(source.JUPITER_API_KEY ? { JUPITER_API_KEY: source.JUPITER_API_KEY } : {}),
  ...(source.JUPITER_PRICE_RPC_URL ? { JUPITER_PRICE_RPC_URL: source.JUPITER_PRICE_RPC_URL } : {}),
});
Object.assign(files["indexer.env"]!, {
  INDEXER_HOST: "127.0.0.1",
  INDEXER_PORT: "42069",
});
Object.assign(files["polymarket.env"]!, {
  POLYMARKET_HOST: "127.0.0.1",
  POLYMARKET_PORT: "42073",
  POLYMARKET_INTERNAL_TOKEN: internalToken,
});
for (const name of Object.keys(files))
  if (existsSync(resolve(target, name)))
    throw new Error(
      "Staged credentials already exist; refusing to rotate/overwrite them",
    );
const patch = [
  "*** Begin Patch",
  ...Object.entries(files).flatMap(([name, values]) => [
    `*** Add File: .local/ec2/env/${name}`,
    ...Object.entries(values).map(([key, value]) => {
      if (/[\r\n$]/.test(value))
        throw new Error(`URL-encode special characters in ${key}`);
      return `+${key}=${JSON.stringify(value)}`;
    }),
  ]),
  "*** End Patch",
  "",
].join("\n");
try {
  execFileSync("apply_patch", [], {
    input: patch,
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
} catch {
  throw new Error("Secret staging failed; diagnostics withheld");
}
for (const name of Object.keys(files)) chmodSync(resolve(target, name), 0o600);
console.log(
  JSON.stringify({
    staged: Object.keys(files),
    walletKeysIncluded: false,
    fileMode: "0600",
  }),
);
