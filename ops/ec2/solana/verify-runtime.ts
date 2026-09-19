/** Read-only proof of TLS, per-service schema isolation, and native DB initialization. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { verifyRuntimeStorage } from "../../../packages/db/src/solana/administration.ts";

const root = resolve(import.meta.dir, "../../..");
for (const service of ["api", "indexer", "polymarket"] as const) {
  const env = parseEnv(readFileSync(resolve(root, `.local/ec2/env/${service}.env`), "utf8"));
  assert(!Object.keys(env).some((key) => /PRIVATE_KEY|SECRET_KEY|KEYPAIR/.test(key)));
  try {
    const row = await verifyRuntimeStorage(env.DATABASE_URL ?? "", service);
    console.log(JSON.stringify({ service, ...row, initialized: true }));
  } catch (error) {
    console.error(
      JSON.stringify({
        service,
        verified: false,
        code: (error as { code?: string }).code ?? "RUNTIME_CHECK_FAILED",
      }),
    );
    process.exitCode = 1;
  }
}
