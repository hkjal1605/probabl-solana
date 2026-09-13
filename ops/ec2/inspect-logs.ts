/** Bounded diagnostic output, with runtime credentials redacted before printing. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

const root = resolve(import.meta.dir, "../..");
const secrets = new Set<string>();
for (const file of [".env", ".env.indexer", ".env.reconciler", ".env.polymarket"]) {
  const values = parseEnv(readFileSync(resolve(root, file), "utf8"));
  if (values.POLYMARKET_INTERNAL_TOKEN) secrets.add(values.POLYMARKET_INTERNAL_TOKEN);
  for (const name of ["ROBINHOOD_RPC_URL", "ROBINHOOD_WS_URL"]) {
    for (const endpoint of (values[name] ?? "").split(",").filter(Boolean)) {
      secrets.add(endpoint);
      // Also protect provider keys if a third-party logger separates URL components.
      const url = new URL(endpoint);
      const key = url.pathname.split("/").filter(Boolean).at(-1);
      if (key && key.length >= 16) secrets.add(key);
    }
  }
  if (values.DATABASE_URL) {
    secrets.add(values.DATABASE_URL);
    const url = new URL(values.DATABASE_URL);
    secrets.add(url.password);
    secrets.add(decodeURIComponent(url.password));
  }
}
const redact = (input: string) => {
  let output = input;
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length))
    output = output.split(secret).join("[REDACTED]");
  return output.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[REDACTED_DATABASE_URL]");
};
for (const service of ["indexer", "reconciler", "polymarket", "api"])
  for (const stream of ["out", "error"]) {
    if (process.argv[2] && process.argv[2] !== service) continue;
    const path = `/home/ubuntu/.pm2/logs/probabl-${service}-${stream}.log`;
    if (!existsSync(path)) continue;
    const content = readFileSync(path);
    console.log(JSON.stringify({ service, stream, bytes: content.length }));
    console.log(redact(content.subarray(Math.max(0, content.length - 8000)).toString()));
  }
