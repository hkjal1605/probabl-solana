import type { Hex } from "@conditional-stocks/market-data";
import type { RedisCache } from "@conditional-stocks/shared/redis-cache";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";

export const PROBABILITY_CACHE_TTL_SECONDS = 60;
export class CachedProbability {
  constructor(
    private readonly cache: RedisCache,
    private readonly load: (condition: Hex) => Promise<unknown>,
  ) {}
  get(condition: string) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(condition)) throw new Error("Invalid condition ID");
    const canonical = condition.toLowerCase() as Hex;
    return this.cache.get(canonical, PROBABILITY_CACHE_TTL_SECONDS, async () => {
      const tick = await this.load(canonical);
      if (
        !tick ||
        typeof tick !== "object" ||
        !("conditionId" in tick) ||
        tick.conditionId !== canonical
      )
        throw new Error("Probability condition mismatch");
      if (
        !("quality" in tick) ||
        tick.quality !== "valid" ||
        !("isStale" in tick) ||
        tick.isStale !== false
      )
        throw new Error("Probability is not currently valid");
      return tick;
    });
  }
}

/** Public API-owned display stream; no RPC, browser credentials, or upstream URLs. */
export function mountProbabilityStream(app: Hono, probabilities: CachedProbability) {
  let streams = 0;
  app.get("/v1/probabilities/:conditionId/stream", (c) => {
    const condition = c.req.param("conditionId").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(condition)) return c.json({ error: "Invalid condition ID" }, 400);
    if (streams >= 2000) return c.json({ error: "Stream capacity reached" }, 503);
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      streams++;
      try {
        while (!stream.aborted) {
          try {
            await stream.writeSSE({
              event: "probability",
              data: JSON.stringify({
                topic: `probability.${condition}`,
                value: await probabilities.get(condition),
              }),
            });
          } catch {
            if (stream.aborted) break;
            await stream.writeSSE({ event: "unavailable", data: "{}" });
          }
          for (let i = 0; i < 4 && !stream.aborted; i++) {
            await stream.sleep(15_000);
            if (!stream.aborted) await stream.writeSSE({ event: "heartbeat", data: "{}" });
          }
        }
      } finally {
        streams--;
      }
    });
  });
}
