const { resolve } = require("node:path");
const root = resolve(__dirname, "../../..");

function service(name, entry, memory) {
  return {
    name: `probabl-sol-${name}`,
    cwd: root,
    script: "/usr/local/bin/bun",
    interpreter: "none",
    args: [
      `--env-file=${resolve(root, `.local/ec2/env/${name}.env`)}`,
      resolve(root, entry),
    ],
    exec_mode: "fork",
    instances: 1,
    watch: false,
    autorestart: true,
    min_uptime: "30s",
    max_restarts: 20,
    exp_backoff_restart_delay: 1000,
    kill_timeout: 30000,
    max_memory_restart: memory,
    merge_logs: true,
    env: {
      NODE_ENV: "production",
      TZ: "UTC",
      NO_COLOR: "1",
      DO_NOT_TRACK: "1",
      ...(name === "api"
        ? {
            INDEXER_SNAPSHOT_SCHEMA: "solana_indexer",
            EVIDENCE_PUBLIC_BASE_URL:
              "https://api-solana.probabl.trade/v1/attachments",
          }
        : {}),
    },
  };
}

// Native orderbook projection and vault reconciliation belong to the indexer;
// order/transaction preparation belongs to the API. No EVM workers or signers.
module.exports = {
  apps: [
    service("indexer", "services/solana-indexer/src/main.ts", "384M"),
    service("polymarket", "services/polymarket-ingestor/src/main.ts", "256M"),
    service("api", "apps/api/src/solana.ts", "384M"),
  ],
};
