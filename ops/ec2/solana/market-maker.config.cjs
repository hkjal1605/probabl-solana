// Explicit opt-in; NOT part of the standard API/indexer deployment.
const { resolve } = require("node:path");
const root = resolve(__dirname, "../../..");
module.exports = {
  apps: [
    {
      name: "probabl-sol-market-maker",
      cwd: root,
      script: "/usr/local/bin/bun",
      interpreter: "none",
      args: [
        "--env-file=" + resolve(root, ".local/ec2/env/market-maker.env"),
        resolve(root, "services/market-maker/src/main.ts"),
        "--execute",
      ],
      instances: 1,
      exec_mode: "fork",
      watch: false,
      autorestart: true,
      min_uptime: "30s",
      max_restarts: 5,
      exp_backoff_restart_delay: 5000,
      kill_timeout: 120000,
      max_memory_restart: "256M",
      merge_logs: true,
      env: { NODE_ENV: "production", TZ: "UTC", NO_COLOR: "1" },
    },
  ],
};
