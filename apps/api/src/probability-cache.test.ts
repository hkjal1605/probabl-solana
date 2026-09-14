import { expect, test } from "bun:test";
import { RedisCache } from "@conditional-stocks/shared/redis-cache";
import { Hono } from "hono";
import { CachedProbability, mountProbabilityStream } from "./probability-cache";

test("probability API shares the canonical condition cache and retains original observations", async () => {
  const values = new Map<string, string>();
  const ttl: number[] = [];
  let reads = 0;
  const condition = `0x${"ab".repeat(32)}`;
  const tick = {
    conditionId: condition,
    observedAtMs: "1800000000000",
    quality: "valid",
    midpointX6: "280000",
  };
  const cache = new RedisCache(
    {
      get: async (key) => values.get(key) ?? null,
      set: async (key, value, _mode, seconds) => {
        values.set(key, value);
        ttl.push(seconds);
      },
    },
    "api-test",
  );
  const probabilities = new CachedProbability(cache, async () => {
    reads++;
    return tick;
  });
  expect(await probabilities.get(condition)).toEqual(tick);
  expect(await probabilities.get(`0x${"AB".repeat(32)}`)).toEqual(tick);
  expect(reads).toBe(1);
  expect(ttl).toEqual([60]);
  expect(() => probabilities.get("../bad")).toThrow("Invalid condition");

  const app = new Hono();
  mountProbabilityStream(app, probabilities);
  expect((await app.request("/v1/probabilities/bad/stream")).status).toBe(400);
  const controller = new AbortController();
  const response = await app.request(`/v1/probabilities/${condition}/stream`, {
    signal: controller.signal,
  });
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(response.headers.get("x-accel-buffering")).toBe("no");
  if (!response.body) throw new Error("Missing SSE response body");
  const reader = response.body.getReader();
  const chunk = new TextDecoder().decode((await reader.read()).value);
  expect(chunk).toContain("event: probability");
  expect(chunk).toContain(tick.observedAtMs);
  expect(reads).toBe(1);
  controller.abort();
  await reader.cancel();
});

test("mismatched upstream conditions never enter Redis", async () => {
  let writes = 0;
  const cache = new RedisCache(
    {
      get: async () => null,
      set: async () => {
        writes++;
      },
    },
    "test",
  );
  const probabilities = new CachedProbability(cache, async () => ({ conditionId: "wrong" }));
  await expect(probabilities.get(`0x${"11".repeat(32)}`)).rejects.toThrow("mismatch");
  expect(writes).toBe(0);
});
