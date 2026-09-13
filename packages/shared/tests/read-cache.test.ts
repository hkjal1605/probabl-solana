import { expect, test } from "bun:test";
import { ReadCache } from "../src/read-cache";

test("simultaneous GETs share one pending read and the exact success TTL", async () => {
  let now = 10_000,
    calls = 0;
  const cache = new ReadCache(2000, 10, 1000, () => now);
  const read = async () => ++calls;
  expect(await Promise.all(Array.from({ length: 100 }, () => cache.get("a", read)))).toEqual(
    Array(100).fill(1),
  );
  now += 1999;
  expect(await cache.get("a", read)).toBe(1);
  now++;
  expect(await cache.get("a", read)).toBe(2);
});
test("failures never turn an expired success into a fresh value, and share bounded backoff", async () => {
  let now = 1000,
    calls = 0;
  const cache = new ReadCache(10, 10, 100, () => now);
  await cache.get("a", async () => "old");
  now += 10;
  const fail = async () => {
    calls++;
    throw new Error("upstream");
  };
  for (let i = 0; i < 20; i++) await expect(cache.get("a", fail)).rejects.toThrow("upstream");
  expect(calls).toBe(1);
  now += 100;
  expect(await cache.get("a", async () => "new")).toBe("new");
});
test("capacity never evicts pending reads or starts unbounded RPC work", async () => {
  const cache = new ReadCache(1000, 2);
  let resolve!: (n: number) => void;
  const held = new Promise<number>((r) => {
    resolve = r;
  });
  const a = cache.get("a", () => held),
    b = cache.get("b", () => held);
  await expect(cache.get("c", async () => 3)).rejects.toThrow("capacity");
  expect(cache.get("a", async () => 9)).toBe(a);
  resolve(1);
  await Promise.all([a, b]);
  expect(await cache.get("c", async () => 3)).toBe(3);
});
test("clock rollback invalidates cached success and synchronous loader exceptions settle", async () => {
  let now = 1000;
  const cache = new ReadCache(500, 10, 10, () => now);
  await cache.get("a", async () => 1);
  now--;
  expect(await cache.get("a", async () => 2)).toBe(2);
  await expect(
    cache.get("b", () => {
      throw new Error("sync");
    }),
  ).rejects.toThrow("sync");
});
