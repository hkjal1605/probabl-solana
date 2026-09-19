/** One-time role/schema bootstrap. SQL is owned by packages/db. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { provisionRuntimeRoles } from "@conditional-stocks/db/solana/administration";

const root = resolve(import.meta.dir, "../../..");
const envRoot = resolve(root, ".local/ec2/env");
const bootstrap = parseEnv(readFileSync(resolve(envRoot, "bootstrap.env"), "utf8"));
const administrator = new URL(bootstrap.DATABASE_URL ?? "");
if (
  administrator.hostname !==
    "probabl-solana-db.cluster-c3uuueq6kfve.ap-northeast-1.rds.amazonaws.com" ||
  administrator.pathname !== "/postgres" ||
  administrator.username !== "postgres" ||
  administrator.searchParams.get("sslmode") !== "verify-full" ||
  bootstrap.SOLANA_GENESIS_HASH !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
)
  throw new Error("Unexpected bootstrap target");

const credentials = Object.fromEntries(
  ["api", "indexer", "polymarket"].map((service) => {
    const env = parseEnv(readFileSync(resolve(envRoot, `${service}.env`), "utf8"));
    const url = new URL(env.DATABASE_URL ?? "");
    if (
      url.host !== administrator.host ||
      url.pathname !== administrator.pathname ||
      url.username !== `probabl_sol_${service}` ||
      !/^[a-f0-9]{64}$/.test(url.password) ||
      url.search !== administrator.search
    )
      throw new Error("Invalid staged runtime credential");
    return [service, url.password];
  }),
) as Record<"api" | "indexer" | "polymarket", string>;

await provisionRuntimeRoles(administrator.toString(), "postgres", credentials);
console.log(
  JSON.stringify({
    provisioned: true,
    adminUsedByServices: false,
    next: "Run both Solana migrations, start Polymarket once, then grant indexed reads.",
  }),
);
