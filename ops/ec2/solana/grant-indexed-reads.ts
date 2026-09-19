/** Narrow cross-schema read grant. SQL is owned by packages/db. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { grantIndexedSnapshotRead } from "@conditional-stocks/db/solana/administration";

const root = resolve(import.meta.dir, "../../..");
const env = parseEnv(readFileSync(resolve(root, ".local/ec2/env/indexer.env"), "utf8"));
await grantIndexedSnapshotRead(env.DATABASE_URL ?? "");
console.log("API granted read-only access to the indexed snapshot table.");
