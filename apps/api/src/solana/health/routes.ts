import type { SolanaDatabase } from "@conditional-stocks/db/solana";
import type { SolanaClient } from "@conditional-stocks/solana-client";
import type { Hono } from "hono";

export function mountHealth(app: Hono, db: SolanaDatabase, client: SolanaClient) {
  app.get("/health", (c) => c.json({ status: "ok", chain: "solana", service: "probabl-api" }));
  app.get("/ready", async (c) => {
    try {
      await client.assertNetwork();
      const config = await client.configAccount();
      await db.ping();
      const response = await fetch(
        new URL("/reconciliation", process.env.INDEXER_URL ?? "http://127.0.0.1:42069"),
        { signal: AbortSignal.timeout(2000), redirect: "error" },
      );
      const indexed = (await response.json()) as { healthy?: boolean };
      const healthy = !config.paused && response.ok && indexed.healthy === true;
      return c.json({ healthy, chain: "solana" }, healthy ? 200 : 503);
    } catch {
      return c.json({ healthy: false, chain: "solana" }, 503);
    }
  });
}
