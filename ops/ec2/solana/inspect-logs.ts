/** Print only bounded, credential-redacted logs, never raw PM2 environment dumps. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

const root = resolve(import.meta.dir, "../../..");
const secrets = new Set<string>();
for (const service of ["api", "indexer", "polymarket", "bootstrap"]) {
  const file = resolve(root, `.local/ec2/env/${service}.env`);
  if (!existsSync(file)) continue;
  const env = parseEnv(readFileSync(file, "utf8"));
  if (env.POLYMARKET_INTERNAL_TOKEN) secrets.add(env.POLYMARKET_INTERNAL_TOKEN);
  for (const name of ["DATABASE_URL", "SOLANA_RPC_URL"]) {
    if (!env[name]) continue;
    secrets.add(env[name]);
    const url = new URL(env[name]);
    for (const part of [
      url.password,
      decodeURIComponent(url.password),
      ...url.searchParams.values(),
    ])
      if (part.length >= 8) secrets.add(part);
  }
}
for (const service of ["api", "indexer", "polymarket"]) {
  for (const stream of ["out", "error"]) {
    const path = `/home/ubuntu/.pm2/logs/probabl-sol-${service}-${stream}.log`;
    if (!existsSync(path)) continue;
    let content = readFileSync(path).subarray(-6000).toString();
    for (const secret of [...secrets].sort((a, b) => b.length - a.length))
      content = content.replaceAll(secret, "[REDACTED]");
    content = content.replace(
      /postgres(?:ql)?:\/\/[^\s"']+/gi,
      "[REDACTED_DATABASE_URL]",
    );
    console.log(JSON.stringify({ service, stream, content }));
  }
}
