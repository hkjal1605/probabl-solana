/** Local fan-out of the indexer's single upstream Yellowstone stream.
 *
 * Hosted gRPC is billed per streamed byte and per connection. The indexer
 * holds the only upstream subscription; other processes on the host (the API)
 * consume the same account and slot events over a loopback HTTP stream,
 * with the same resume-from-slot semantics as Yellowstone. Transactions and
 * block times are not relayed: only the indexer's history needs them. */
import { EventEmitter } from "node:events";
import type { AccountVersion } from "./accounts.ts";
import type { ChainEvent, GeyserClient, GeyserClientFactory, GeyserStream, SlotStatus } from "./geyser.ts";

type Relayed = Extract<ChainEvent, { kind: "account" | "slot" }>;
const eventSlot = (event: Relayed) => (event.kind === "account" ? event.version.slot : event.slot);

/** One relayed event as a compact JSON line. */
export function encodeEvent(event: Relayed): string {
  if (event.kind === "slot")
    return JSON.stringify({ k: "s", s: event.slot, t: event.status, ...(event.parent !== undefined ? { p: event.parent } : {}) });
  const v = event.version;
  return JSON.stringify({
    k: "a",
    a: event.address,
    s: v.slot,
    w: v.writeVersion.toString(),
    o: v.owner,
    l: v.lamports.toString(),
    d: v.data.toString("base64"),
  });
}

export function decodeEvent(line: string): ChainEvent | undefined {
  const m = JSON.parse(line) as Record<string, any>;
  if (m.k === "s")
    return { kind: "slot", slot: m.s, status: m.t as SlotStatus, ...(m.p !== undefined ? { parent: m.p } : {}) };
  if (m.k === "a") {
    const version: AccountVersion = {
      slot: m.s,
      writeVersion: BigInt(m.w),
      owner: m.o,
      lamports: BigInt(m.l),
      data: Buffer.from(m.d, "base64"),
    };
    return { kind: "account", address: m.a, version };
  }
  return undefined; // Heartbeat.
}

export interface RelayOptions {
  /** Slots of events kept for consumers resuming after a reconnect. */
  retainSlots?: number;
  heartbeatMs?: number;
}

export class ChainRelay {
  /** Retained events in arrival order, with the slot they belong to. */
  private buffer: { slot: number; line: string }[] = [];
  private head = 0;
  private highest = -1;
  private readonly consumers = new Set<{ send(line: string): void; close(): void }>();
  private server: ReturnType<typeof Bun.serve> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: RelayOptions = {}) {}

  /** Oldest slot whose events are fully retained, if any. */
  firstAvailable(): number | undefined {
    return this.head < this.buffer.length ? this.buffer[this.head]!.slot : undefined;
  }

  get subscribers() {
    return this.consumers.size;
  }

  /** Forwards one upstream event (transactions and block times are dropped). */
  publish(event: ChainEvent) {
    if (event.kind !== "account" && event.kind !== "slot") return;
    const slot = eventSlot(event);
    const line = encodeEvent(event);
    this.buffer.push({ slot, line });
    if (slot > this.highest) this.highest = slot;
    for (const consumer of this.consumers) consumer.send(line);
    this.prune();
  }

  /** The upstream re-bootstrapped: history is discontinuous, so consumers
   * must resynchronize too. */
  reset() {
    this.buffer = [];
    this.head = 0;
    this.highest = -1;
    for (const consumer of [...this.consumers]) consumer.close();
    this.consumers.clear();
  }

  /** Whole slots older than the retention window are dropped. */
  private prune() {
    const floor = this.highest - (this.options.retainSlots ?? 1_000);
    while (this.head < this.buffer.length && this.buffer[this.head]!.slot < floor) this.head++;
    if (this.head > 4_096 && this.head * 2 > this.buffer.length) {
      this.buffer = this.buffer.slice(this.head);
      this.head = 0;
    }
  }

  /** Serves `GET /replay-info` and `GET /stream?from=<slot>` on loopback. */
  serve(port: number, hostname = "127.0.0.1") {
    const relay = this;
    this.server = Bun.serve({
      hostname,
      port,
      idleTimeout: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/replay-info") {
          // Nothing relayed yet (the indexer is starting): consumers retry
          // later instead of treating it as a gap and re-bootstrapping.
          const first = relay.firstAvailable();
          if (first === undefined) return new Response("relay warming up", { status: 503 });
          return Response.json({ firstAvailable: String(first) });
        }
        if (url.pathname !== "/stream") return new Response("not found", { status: 404 });
        const from = url.searchParams.get("from");
        const fromSlot = from === null || from === "" ? undefined : Number(from);
        if (fromSlot !== undefined && !Number.isSafeInteger(fromSlot)) return new Response("bad from", { status: 400 });
        const encoder = new TextEncoder();
        let consumer: { send(line: string): void; close(): void } | undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            consumer = {
              send: (line) => controller.enqueue(encoder.encode(line + "\n")),
              close: () => {
                try {
                  controller.close();
                } catch {
                  /* Already closed. */
                }
              },
            };
            if (fromSlot !== undefined)
              for (let i = relay.head; i < relay.buffer.length; i++) {
                const entry = relay.buffer[i]!;
                if (entry.slot >= fromSlot) consumer.send(entry.line);
              }
            relay.consumers.add(consumer);
          },
          cancel() {
            if (consumer) relay.consumers.delete(consumer);
          },
        });
        return new Response(body, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
      },
    });
    // Keeps idle consumers' health fresh when no slot passes (never on a live chain).
    this.heartbeat = setInterval(() => {
      for (const consumer of this.consumers) consumer.send("{}");
    }, this.options.heartbeatMs ?? 5_000);
    this.heartbeat.unref?.();
    return this.server;
  }

  stop() {
    clearInterval(this.heartbeat);
    for (const consumer of [...this.consumers]) consumer.close();
    this.consumers.clear();
    void this.server?.stop(true);
  }
}

/** A Yellowstone-shaped client reading a local `ChainRelay`. */
class RelayStream extends EventEmitter implements GeyserStream {
  private readonly abort = new AbortController();
  private started = false;

  constructor(private readonly url: string) {
    super();
  }

  write(request: unknown, callback?: (error?: Error | null) => void) {
    // Only the first request opens the stream (its `fromSlot` resumes it);
    // filter updates and pong replies have nothing to do on a relay.
    if (!this.started) {
      this.started = true;
      const from = (request as { fromSlot?: string }).fromSlot;
      void this.read(from);
    }
    queueMicrotask(() => callback?.(null));
    return true;
  }

  private async read(from: string | undefined) {
    try {
      const response = await fetch(`${this.url}/stream${from === undefined ? "" : `?from=${from}`}`, { signal: this.abort.signal });
      if (!response.ok || !response.body) throw new Error(`Chain relay responded ${response.status}`);
      const decoder = new TextDecoder();
      let pending = "";
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          const event = decodeEvent(line);
          this.emit("data", event ? { chainEvent: event } : {});
        }
      }
      this.emit("end");
    } catch (error) {
      if (!this.abort.signal.aborted) this.emit("error", error);
    }
  }

  end() {
    this.abort.abort();
  }

  destroy(error?: Error) {
    this.abort.abort();
    if (error) this.emit("error", error);
  }
}

/** Geyser clients for the API (or any co-located consumer) of the indexer's relay. */
export function relayClientFactory(url: string): GeyserClientFactory {
  const base = url.replace(/\/+$/, "");
  return (): GeyserClient => ({
    connect: async () => {},
    subscribeReplayInfo: async () => {
      const response = await fetch(`${base}/replay-info`);
      if (!response.ok) throw new Error(`Chain relay responded ${response.status}`);
      return { firstAvailable: ((await response.json()) as { firstAvailable: string }).firstAvailable };
    },
    subscribe: async () => new RelayStream(base),
  });
}
