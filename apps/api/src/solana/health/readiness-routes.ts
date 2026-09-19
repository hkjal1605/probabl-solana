import { ReadCache } from "@conditional-stocks/shared/read-cache";
import { isSolanaMint } from "@conditional-stocks/shared/spot-prices";
import { big, key, type SolanaClient } from "@conditional-stocks/solana-client";
import type { Hono } from "hono";

/** Advisory UI status only. Mutating endpoints still read and validate live chain state. */
export function mountTradingReadiness(
  app: Hono,
  client: Pick<SolanaClient, "assertNetwork" | "configAccount" | "market">,
  cache = new ReadCache(),
  now = Date.now,
) {
  app.get("/v1/system/readiness", async (c) => {
    c.header("Cache-Control", "no-store");
    const marketId = c.req.query("marketId");
    if (marketId && !isSolanaMint(marketId))
      return c.json({ error: { message: "Invalid market address" } }, 400);
    try {
      const config = await cache.get("config", async () => {
        await client.assertNetwork();
        return client.configAccount();
      });
      let reason = config.paused ? "paused" : "ready";
      if (reason === "ready" && marketId) {
        const market = await cache.get(`market:${marketId}`, () => client.market(key(marketId)));
        const at = BigInt(Math.floor(now() / 1000));
        reason =
          market.state !== 2
            ? market.state === 1
              ? "scheduled"
              : "closed"
            : big(market.terms.trading_cutoff) <= at
              ? "closed"
              : big(market.terms.trading_open) > at
                ? "scheduled"
                : "ready";
      }
      // Business state is not a failed HTTP request. Never translate RPC failure into "closed".
      return c.json({ healthy: reason === "ready", reason, checkedAt: now(), chain: "solana" });
    } catch {
      c.header("Retry-After", "2");
      return c.json(
        { healthy: false, reason: "unavailable", checkedAt: now(), chain: "solana" },
        503,
      );
    }
  });
}
