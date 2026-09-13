const { resolve } = require("node:path");

const root = resolve(__dirname, "../..");
const common = {
  cwd: root,
  script: "/usr/local/bin/bun",
  interpreter: "none",
  exec_mode: "fork",
  instances: 1,
  autorestart: true,
  watch: false,
  min_uptime: "30s",
  max_restarts: 20,
  exp_backoff_restart_delay: 1000,
  kill_timeout: 90000,
  merge_logs: true,
  env: {
    NODE_ENV: "production",
    TZ: "UTC",
    NO_COLOR: "1",
    PONDER_TELEMETRY_DISABLED: "true",
    PONDER_CACHE_BYTES: "268435456",
    PONDER_MAX_THREADS: "2",
    DO_NOT_TRACK: "1",
  },
};

function service(name, entry, memory, extra = []) {
  return {
    ...common,
    name: `probabl-${name}`,
    max_memory_restart: memory,
    args: [
      `--env-file=${resolve(root, ".env")}`,
      ...(name === "api" ? [] : [`--env-file=${resolve(root, `.env.${name}`)}`]),
      resolve(root, entry),
      ...extra,
    ],
  };
}

// Orderbook planning and gateway recovery run inside the API. No matcher/relayer,
// Redis, frontend, or wallet signer belongs in this process list.
module.exports = {
  apps: [
    service("indexer", "ops/ec2/indexer.ts", "1400M", [
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      "42069",
      "--disable-ui",
      "--log-format",
      "json",
    ]),
    service("reconciler", "services/rh-indexer/scripts/reconcile.ts", "384M", ["watch"]),
    service("polymarket", "services/polymarket-ingestor/src/main.ts", "384M"),
    service("api", "apps/api/src/index.ts", "512M"),
  ],
};
