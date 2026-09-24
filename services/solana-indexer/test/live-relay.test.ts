import { afterEach, describe, expect, test } from "bun:test";
import { bn, encodeAccount } from "@conditional-stocks/solana-client";
import type { ChainEvent } from "../src/live/geyser.ts";
import { LiveIndex } from "../src/live/index.ts";
import { ChainRelay, decodeEvent, encodeEvent, relayClientFactory } from "../src/live/relay.ts";
import { fakeConnection, fakeGeyser, legInfos, liveFixture, programAccounts, until, updates, version } from "./live-fixture.ts";

const account = (address: string, slot: number, data = Buffer.from([1, 2, 3])): ChainEvent => ({
  kind: "account",
  address,
  version: version(slot, data, "owner", 7n, 9n),
});
const slot = (n: number, status: "processed" | "confirmed" | "finalized" = "confirmed", parent?: number): ChainEvent => ({
  kind: "slot",
  slot: n,
  status,
  ...(parent !== undefined ? { parent } : {}),
});

const relays: ChainRelay[] = [];
afterEach(() => {
  for (const relay of relays.splice(0)) relay.stop();
});
function serve(options: ConstructorParameters<typeof ChainRelay>[0] = {}) {
  const relay = new ChainRelay(options);
  relays.push(relay);
  const server = relay.serve(0);
  return { relay, url: `http://127.0.0.1:${server.port}` };
}

/** Opens a relay stream (the consumer is registered once headers arrive)
 * and returns a collector for its decoded lines. */
async function open(url: string, from: number | undefined) {
  const controller = new AbortController();
  const response = await fetch(`${url}/stream${from === undefined ? "" : `?from=${from}`}`, { signal: controller.signal });
  const reader = response.body!.getReader();
  const lines: (ChainEvent | undefined)[] = [];
  const decoder = new TextDecoder();
  let pending = "";
  return async (done: (lines: (ChainEvent | undefined)[]) => boolean) => {
    while (!done(lines)) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      pending += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        lines.push(decodeEvent(pending.slice(0, end)));
        pending = pending.slice(end + 1);
      }
    }
    controller.abort();
    return lines;
  };
}

describe("chain relay", () => {
  test("events round-trip exactly through their line encoding", () => {
    for (const event of [account("A", 5), slot(6, "processed", 5), slot(7, "finalized")] as const) {
      const line = encodeEvent(event as never);
      expect(line.includes("\n")).toBe(false);
      expect(decodeEvent(line)).toEqual(event);
    }
    expect(decodeEvent("{}")).toBeUndefined();
  });

  test("retains whole recent slots, drops transactions and block times", () => {
    const relay = new ChainRelay({ retainSlots: 2 });
    expect(relay.firstAvailable()).toBeUndefined();
    relay.publish({ kind: "blockTime", slot: 1, blockTime: 1 });
    relay.publish({ kind: "transaction", slot: 1, signature: "s", response: {} as never });
    expect(relay.firstAvailable()).toBeUndefined();
    for (let n = 10; n <= 14; n++) relay.publish(account("A", n));
    // Highest 14, window 2: slots 12..14 remain.
    expect(relay.firstAvailable()).toBe(12);
    relay.reset();
    expect(relay.firstAvailable()).toBeUndefined();
    // Long runs compact the buffer without losing the window.
    const busy = new ChainRelay({ retainSlots: 10 });
    for (let n = 0; n < 10_000; n++) busy.publish(slot(n));
    expect(busy.firstAvailable()).toBe(9_989);
  });

  test("streams from a slot: retained events first, then live, with heartbeats", async () => {
    const { relay, url } = serve({ heartbeatMs: 10 });
    expect((await fetch(`${url}/replay-info`)).status).toBe(503); // Warming up.
    relay.publish(account("A", 5));
    relay.publish(slot(5));
    relay.publish(account("B", 6));
    expect(await (await fetch(`${url}/replay-info`)).json()).toEqual({ firstAvailable: "5" });
    const collect = await open(url, 6);
    relay.publish(slot(6));
    const lines = await collect((l) => l.filter(Boolean).length >= 2 && l.some((x) => x === undefined));
    expect(lines.filter(Boolean)).toEqual([account("B", 6), slot(6)]);
    // Without `from`, only live events.
    const live = await open(url, undefined);
    relay.publish(slot(7));
    expect((await live((l) => l.filter(Boolean).length >= 1)).filter(Boolean)).toEqual([slot(7)]);
    expect((await fetch(`${url}/stream?from=x`)).status).toBe(400);
    expect((await fetch(`${url}/other`)).status).toBe(404);
  });

  test("a reset ends every consumer stream", async () => {
    const { relay, url } = serve();
    relay.publish(slot(1));
    const response = await fetch(`${url}/stream?from=1`);
    await until(() => relay.subscribers === 1);
    relay.reset();
    expect(await response.text()).toBe(encodeEvent(slot(1) as never) + "\n");
    expect(relay.subscribers).toBe(0);
  });
});

describe("relay-fed live index", () => {
  test("a consumer index built from the relay matches the upstream index", async () => {
    const f = liveFixture(2);
    const connection = fakeConnection({
      program: f.s.program,
      slot: 100,
      programAccounts: programAccounts(f.s, f.config),
      others: legInfos(f.bases, f.config, f.s.program),
    });
    const { relay, url } = serve();
    const upstreamGeyser = fakeGeyser();
    const upstream = new LiveIndex({
      client: { ...f.client, connection } as never,
      geyser: upstreamGeyser.factory,
      onEvent: (event) => relay.publish(event),
    });
    await upstream.start();
    const push = (u: Record<string, unknown>) => upstreamGeyser.state.stream!.push(u);
    push(updates.slot(101, 0, 100));
    push(updates.account(f.orderId, 101, f.s.program, encodeAccount("Order", { ...f.order, remaining: bn(3) })));
    push(updates.slot(101, 1));
    const errors: unknown[] = [];
    const consumer = new LiveIndex({
      client: { ...f.client, connection } as never,
      geyser: relayClientFactory(url + "/"),
      source: { backoffMs: 1, maxBackoffMs: 4 },
      onError: (error) => errors.push(error),
    });
    await consumer.start();
    await until(() => consumer.health().connected && consumer.confirmed().slot >= 101);
    expect(consumer.confirmed().orders.get(f.orderId)!.remaining.toString()).toBe("3");
    push(updates.account(f.orderId, 102, f.s.program, encodeAccount("Order", { ...f.order, remaining: bn(1) })));
    push(updates.slot(102, 1));
    push(updates.slot(102, 2));
    await until(() => consumer.finalized().slot >= 102);
    expect(consumer.finalized().orders.get(f.orderId)!.remaining.toString()).toBe("1");
    expect(consumer.confirmed().orders.get(f.orderId)).toEqual(upstream.confirmed().orders.get(f.orderId));
    // Filter updates and pong replies are no-ops on a relay.
    const stream = (consumer as unknown as { source: { stream: { write(r: unknown, cb: () => void): void } } }).source.stream;
    await new Promise<void>((resolve) => stream.write({ ping: { id: 1 } }, resolve));
    // A dropped relay stream reconnects and resumes after the confirmed slot.
    (stream as unknown as { destroy(e: Error): void }).destroy(new Error("dropped"));
    await until(() => errors.some((e) => String(e).includes("dropped")) && consumer.health().connected);
    push(updates.account(f.orderId, 103, f.s.program, encodeAccount("Order", { ...f.order, remaining: bn(0), status: 2 })));
    push(updates.slot(103, 1));
    await until(() => consumer.confirmed().slot >= 103);
    expect(consumer.confirmed().orders.get(f.orderId)!.status).toBe(2);
    // Upstream re-bootstrap: consumers are cut off and resynchronize.
    relay.reset();
    relay.publish({ kind: "slot", slot: 200, status: "confirmed" });
    await until(() => errors.some((e) => String(e).includes("cannot replay")));
    consumer.stop();
    upstream.stop();
  });

  test("an unreachable relay is retried, not treated as a gap", async () => {
    const f = liveFixture(1);
    const connection = fakeConnection({
      program: f.s.program,
      slot: 100,
      programAccounts: programAccounts(f.s, f.config),
      others: legInfos(f.bases, f.config, f.s.program),
    });
    const errors: unknown[] = [];
    const resyncs: number[] = [];
    const { relay, url } = serve();
    const consumer = new LiveIndex({
      client: { ...f.client, connection } as never,
      geyser: relayClientFactory(url),
      source: { backoffMs: 1, maxBackoffMs: 4 },
      onError: (error) => errors.push(error),
      onResync: (s) => resyncs.push(s),
    });
    await consumer.start();
    await until(() => errors.length >= 2);
    expect(String(errors[0])).toContain("503");
    expect(resyncs).toEqual([]);
    relay.publish({ kind: "slot", slot: 100, status: "confirmed" });
    await until(() => consumer.health().connected);
    consumer.stop();
    // A relay that goes away mid-stream is reported and retried too.
    const gone = new LiveIndex({
      client: { ...f.client, connection } as never,
      geyser: relayClientFactory("http://127.0.0.1:9"),
      source: { backoffMs: 1, maxBackoffMs: 4 },
      onError: (error) => errors.push(error),
    });
    const before = errors.length;
    await gone.start();
    await until(() => errors.length > before + 1);
    gone.stop();
  });
});
