import { expect, test } from "bun:test";
import { RedisClient } from "bun";
import { RedisCache, type RedisCacheClient } from "../src/redis-cache";

function fixture() {
  const values = new Map<string, string>();
  const writes: number[] = [];
  const client: RedisCacheClient = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value, mode, ttl) => {
      expect(mode).toBe("EX");
      writes.push(ttl);
      values.set(key, value);
    },
  };
  return { values, writes, client, cache: new RedisCache(client, "test") };
}

test("Redis cache shares concurrent misses and does not renew TTL on hits", async () => {
  const { cache, writes } = fixture();
  let calls = 0;
  const load = async () => ({ count: ++calls });
  const results = await Promise.all(
    Array.from({ length: 20 }, () => cache.get("condition", 60, load)),
  );
  expect(results.every((value) => value.count === 1)).toBe(true);
  expect(await cache.get("condition", 60, load)).toEqual({ count: 1 });
  expect(writes).toEqual([60]);
});

test("expired/corrupt entries refresh; failures are not cached; namespaces are isolated", async () => {
  const { cache, values, client } = fixture();
  values.set("test:a", JSON.stringify({ expiresAt: Date.now() - 1, value: "old" }));
  expect(await cache.get("a", 60, async () => "fresh")).toBe("fresh");
  values.set("test:a", "broken json");
  expect(await cache.get("a", 60, async () => "repaired")).toBe("repaired");
  await expect(
    cache.get("failure", 60, async () => {
      throw new Error("upstream");
    }),
  ).rejects.toThrow("upstream");
  expect(values.has("test:failure")).toBe(false);
  expect(await cache.get("failure", 60, async () => "recovered")).toBe("recovered");
  expect(await new RedisCache(client, "other").get("a", 60, async () => "other")).toBe("other");
  await expect(cache.get("a", 0, async () => "bad")).rejects.toThrow("TTL");
});

test("Redis failures allow fresh reads instead of serving old values", async () => {
  let warnings = 0;
  const fail = async () => {
    throw new Error("Redis offline");
  };
  const cache = new RedisCache({ get: fail, set: fail }, "test", () => warnings++);
  expect(await cache.get("a", 60, async () => "fresh")).toBe("fresh");
  expect(warnings).toBe(2);
});

test.skipIf(!process.env.TEST_REDIS_URL)(
  "real Redis stores JSON with a 60-second TTL",
  async () => {
    const url = process.env.TEST_REDIS_URL;
    if (!url?.startsWith("redis+unix:///private/tmp/"))
      throw new Error("Use an isolated test Redis socket");
    const client = new RedisClient(url);
    await client.connect();
    const namespace = `probabl-test:${crypto.randomUUID()}`;
    const cache = new RedisCache(client, namespace);
    try {
      expect(await cache.get("key", 60, async () => ({ value: 42 }))).toEqual({ value: 42 });
      expect(await client.ttl(`${namespace}:key`)).toBeGreaterThan(58);
      expect(await cache.get("key", 60, async () => ({ value: 99 }))).toEqual({ value: 42 });
    } finally {
      client.close();
    }
  },
);
