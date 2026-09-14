import { expect, test } from "bun:test";
import { Hono } from "hono";
import { PublicKey } from "@solana/web3.js";
import { changedTopics, createIndexStream } from "../src/stream";
import type { Snapshot } from "../src/projection";
const id = PublicKey.unique().toBase58();
const empty = (): Snapshot => ({ slot: 1, observedAt: Date.now(), markets: new Map(), orders: new Map(), wallets: new Map(), traders: new Map(), rawAccounts: [] } as unknown as Snapshot);
test("unchanged account images produce no data invalidation despite new slots", () => {
  const before = empty();
  expect(changedTopics(before, { ...before, slot: 2 })).toMatchObject({ slot: 2, markets: [], owners: [] });
});
test("both old and new owners are invalidated on removal/change", () => {
  const before = empty(), next = empty();
  before.rawAccounts = [{ address: id, data: "old" }];
  before.wallets.set(id, { owner: new PublicKey(id) } as any);
  expect(changedTopics(before, next).owners).toEqual([id]);
});
test("SSE begins with a resynchronization frame and shuts down on cancellation", async () => {
  const app = new Hono(), hub = createIndexStream(), state = empty();
  hub.mount(app, () => state);
  const response = await app.request("/stream");
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(response.headers.get("x-accel-buffering")).toBe("no");
  const reader = response.body!.getReader();
  const text = new TextDecoder().decode((await reader.read()).value);
  expect(text).toContain("event: reset");
  expect(text).toContain('"slot":1');
  await reader.cancel();
});
