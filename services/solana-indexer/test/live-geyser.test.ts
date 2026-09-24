import { describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import {
  GeyserSource,
  ReplayUnavailable,
  compressionRejected,
  normalize,
  pingRequest,
  replayable,
  subscribeRequest,
  transactionResponse,
  type ChainEvent,
} from "../src/live/geyser.ts";
import { fakeGeyser, tick, until, updates } from "./live-fixture.ts";

const program = Keypair.generate().publicKey;
const U64_MAX = "18446744073709551615";

function geyserTransaction(overrides: { meta?: Record<string, unknown>; message?: unknown } = {}) {
  const payer = Keypair.generate().publicKey,
    loadedW = Keypair.generate().publicKey,
    loadedR = Keypair.generate().publicKey;
  return {
    keys: { payer, loadedW, loadedR },
    info: {
      signature: new Uint8Array(64).fill(7),
      transaction: {
        message:
          "message" in overrides
            ? overrides.message
            : {
                accountKeys: [payer.toBytes(), program.toBytes()],
                instructions: [{ programIdIndex: 1, accounts: new Uint8Array([0, 2, 3]), data: new Uint8Array([1, 2]) }],
              },
      },
      meta: {
        err: undefined,
        logMessages: ["Program log: hi"],
        logMessagesNone: false,
        loadedWritableAddresses: [loadedW.toBytes()],
        loadedReadonlyAddresses: [loadedR.toBytes()],
        ...overrides.meta,
      },
    },
  };
}

describe("Yellowstone update normalization", () => {
  test("account, slot, transaction and block-time updates become chain events", () => {
    const address = Keypair.generate().publicKey;
    const account = normalize(updates.account(address.toBase58(), 12, program, Buffer.from([1, 2]), 5, 99));
    expect(account).toEqual({
      kind: "account",
      address: address.toBase58(),
      version: { slot: 12, writeVersion: 5n, owner: program.toBase58(), lamports: 99n, data: Buffer.from([1, 2]) },
    });
    expect(normalize(updates.slot(13, 0, 12))).toEqual({ kind: "slot", slot: 13, parent: 12, status: "processed" });
    expect(normalize(updates.slot(13, 1))).toEqual({ kind: "slot", slot: 13, status: "confirmed" });
    expect(normalize(updates.slot(13, 2))!).toMatchObject({ status: "finalized" });
    expect(normalize(updates.slot(13, 6))!).toMatchObject({ status: "dead" });
    // First-shred / completed / created-bank statuses carry nothing for the index.
    for (const status of [3, 4, 5]) expect(normalize(updates.slot(13, status))).toBeUndefined();
    expect(normalize(updates.blockTime(13, 1_700_000_000))).toEqual({ kind: "blockTime", slot: 13, blockTime: 1_700_000_000 });
    expect(normalize({ blockMeta: { slot: "13" } })).toBeUndefined();
    expect(normalize({ pong: { id: 1 } })).toBeUndefined();
    expect(normalize({ ping: {} })).toBeUndefined();

    const { info, keys } = geyserTransaction();
    const event = normalize({ transaction: { slot: "14", transaction: info } }) as Extract<ChainEvent, { kind: "transaction" }>;
    expect(event.kind).toBe("transaction");
    expect(event.signature).toBe(bs58.encode(info.signature));
    expect(event.slot).toBe(14);
    const message = event.response.transaction.message;
    const accountKeys = message.getAccountKeys();
    expect(accountKeys.get(0)!.equals(keys.payer)).toBe(true);
    expect(accountKeys.get(2)!.equals(keys.loadedW)).toBe(true);
    expect(accountKeys.get(3)!.equals(keys.loadedR)).toBe(true);
    expect(message.compiledInstructions[0]).toEqual({ programIdIndex: 1, accountKeyIndexes: [0, 2, 3], data: new Uint8Array([1, 2]) });
    expect(event.response.meta).toMatchObject({ err: null, logMessages: ["Program log: hi"] });
    expect(event.response.slot).toBe(14);
  });

  test("transaction status details survive; missing parts are rejected", () => {
    const failed = geyserTransaction({ meta: { err: { err: new Uint8Array([1]) }, logMessagesNone: true } }).info;
    const response = transactionResponse(failed as never, 3);
    expect(response.meta!.err).toEqual({ err: new Uint8Array([1]) });
    expect(response.meta!.logMessages).toBeNull();
    expect(() => transactionResponse({ ...geyserTransaction().info, meta: undefined } as never, 1)).toThrow("missing");
    expect(() => transactionResponse(geyserTransaction({ message: undefined }).info as never, 1)).toThrow("missing");
  });

  test("subscription and keep-alive requests", () => {
    const live = subscribeRequest(program.toBase58(), []);
    expect(live).toEqual({
      accounts: { program: { account: [], owner: [program.toBase58()], filters: [] } },
      slots: { slots: { filterByCommitment: false, interslotUpdates: false } },
      transactions: {
        program: { vote: false, failed: false, accountInclude: [program.toBase58()], accountExclude: [], accountRequired: [] },
      },
      transactionsStatus: {},
      blocks: {},
      blocksMeta: { times: {} },
      entry: {},
      accountsDataSlice: [],
      commitment: 1,
    });
    const resumed = subscribeRequest(program.toBase58(), ["a", "b"], 42);
    expect(resumed.accounts.tracked).toEqual({ account: ["a", "b"], owner: [], filters: [] });
    expect(resumed.fromSlot).toBe("42");
    const ping = pingRequest(3);
    expect(ping.ping).toEqual({ id: 3 });
    // Every request map must be present for the client's encoder.
    for (const field of ["accounts", "slots", "transactions", "transactionsStatus", "blocks", "blocksMeta", "entry"])
      expect(ping[field as keyof typeof ping]).toEqual({});
  });

  test("replay availability", () => {
    expect(replayable(undefined, 5)).toBe(false);
    expect(replayable(U64_MAX, 5)).toBe(true); // Nothing trimmed yet.
    expect(replayable("5", 5)).toBe(true);
    expect(replayable("6", 5)).toBe(false);
    const gap = new ReplayUnavailable(5, 6);
    expect(gap.message).toContain("slot 5 (first available 6)");
    expect(new ReplayUnavailable(5, undefined).message).toContain("unknown");
  });
});

function source(options: { firstAvailable?: string | undefined; resume?: () => number | undefined; compression?: boolean } = {}) {
  const geyser = fakeGeyser("firstAvailable" in options ? { firstAvailable: options.firstAvailable } : {});
  const events: ChainEvent[] = [],
    errors: unknown[] = [],
    gaps: ReplayUnavailable[] = [];
  const src = new GeyserSource(
    geyser.factory,
    { program: program.toBase58(), backoffMs: 1, maxBackoffMs: 4, ...(options.compression !== undefined ? { compression: options.compression } : {}) },
    {
      onEvent: (event) => events.push(event),
      resume: options.resume ?? (() => undefined),
      onGap: (gap) => gaps.push(gap),
      onError: (error) => errors.push(error),
    },
  );
  return { src, geyser, events, errors, gaps };
}

describe("resilient Geyser source", () => {
  test("subscribes, streams events in order and resumes from the caller's slot", async () => {
    let resume: number | undefined;
    const t = source({ resume: () => resume });
    expect(t.src.connected).toBe(false);
    await t.src.start();
    expect(t.src.connected).toBe(true);
    const first = t.geyser.state.stream!;
    expect(first.writes[0]).toEqual(subscribeRequest(program.toBase58(), []));
    first.push(updates.slot(10, 1));
    first.push({ pong: { id: 1 } });
    expect(t.events).toEqual([{ kind: "slot", slot: 10, status: "confirmed" }]);
    expect(Date.now() - t.src.lastMessageAt).toBeLessThan(1000);
    // A malformed update is reported, not thrown into the stream.
    first.push({ transaction: { slot: "1", transaction: { signature: new Uint8Array(64) } } });
    expect(String(t.errors.at(-1))).toContain("missing");
    // Stream failure: reconnect with backoff, replaying from the resume slot.
    resume = 11;
    first.emit("error", new Error("reset"));
    expect(t.src.connected).toBe(false);
    await until(() => t.geyser.state.streams.length === 2 && t.src.connected);
    expect(t.geyser.state.stream!.writes[0]).toMatchObject({ fromSlot: "11" });
    expect(String(t.errors.at(-1))).toContain("reset");
    // Late events from the abandoned stream are ignored.
    first.push(updates.slot(99, 1));
    first.emit("end");
    expect(t.events.length).toBe(1);
    // A graceful end reconnects too.
    t.geyser.state.stream!.emit("end");
    await until(() => t.geyser.state.streams.length === 3 && t.src.connected);
    t.geyser.state.stream!.emit("close");
    await until(() => t.geyser.state.streams.length === 4 && t.src.connected);
    t.src.stop();
    expect(t.geyser.state.stream!.ended).toBe(true);
    expect(t.src.connected).toBe(false);
  });

  test("tracked accounts update the live subscription only when they change", async () => {
    const t = source();
    t.src.track(["b", "a"]); // Before connecting: used by the first request.
    await t.src.start();
    const stream = t.geyser.state.stream!;
    expect((stream.writes[0] as ReturnType<typeof subscribeRequest>).accounts.tracked!.account).toEqual(["a", "b"]);
    t.src.track(["a", "b", "a"]);
    expect(stream.writes.length).toBe(1);
    t.src.track(["c"]);
    expect(stream.writes.length).toBe(2);
    expect(stream.writes[1]).toEqual(subscribeRequest(program.toBase58(), ["c"]));
    t.src.stop();
  });

  test("an unreplayable resume slot reports a gap instead of subscribing", async () => {
    for (const firstAvailable of ["20", undefined]) {
      const t = source({ firstAvailable, resume: () => 10 });
      await t.src.start();
      expect(t.geyser.state.streams.length).toBe(0);
      expect(t.gaps[0]!.fromSlot).toBe(10);
      expect(t.gaps[0]!.firstAvailable).toBe(firstAvailable === undefined ? undefined : 20);
      expect(t.src.connected).toBe(false);
    }
  });

  test("connection, subscription and request failures retry with capped backoff", async () => {
    const t = source();
    t.geyser.state.failConnect = 2;
    t.geyser.state.failSubscribe = 1;
    await t.src.start();
    await until(() => t.src.connected);
    expect(t.geyser.state.clients).toBe(4);
    expect(t.errors.map(String)).toEqual(["Error: connect refused", "Error: connect refused", "Error: subscribe refused"]);
    // The subscribe write itself failing closes that stream and retries.
    t.src.stop();
    const u = source();
    let failures = 1;
    const factory = u.geyser.factory;
    (u.src as unknown as { factory: typeof factory }).factory = (options) => {
      const client = factory(options);
      const subscribe = client.subscribe;
      client.subscribe = async () => {
        const stream = await subscribe();
        if (failures-- > 0) (stream as unknown as { failWrite: Error }).failWrite = new Error("write failed");
        return stream;
      };
      return client;
    };
    await u.src.start();
    await until(() => u.src.connected);
    expect(u.geyser.state.streams[0]!.ended).toBe(true);
    expect(String(u.errors[0])).toContain("write failed");
    expect(u.geyser.state.streams.length).toBe(2);
    u.src.stop();
  });

  test("stop wins over in-flight connects and pending reconnect timers", async () => {
    const t = source();
    let release!: () => void;
    t.geyser.state.hold = new Promise<void>((resolve) => (release = resolve));
    const starting = t.src.start();
    await tick();
    t.src.stop();
    release();
    await starting;
    expect(t.geyser.state.streams[0]!.ended).toBe(true);
    expect(t.src.connected).toBe(false);
    // A reconnect timer armed before stop() never fires into a restarted source.
    t.geyser.state.hold = undefined;
    await t.src.start();
    t.geyser.state.failConnect = 1;
    t.geyser.state.stream!.emit("error", new Error("drop"));
    t.src.stop();
    await Bun.sleep(20);
    expect(t.geyser.state.streams.length).toBe(2);
    await t.src.start();
    await Bun.sleep(20);
    expect(t.geyser.state.streams.length).toBe(3);
    expect(t.src.connected).toBe(true);
    t.src.stop();
    // Stopping while the replay check is in flight abandons the connect.
    const u = source({ resume: () => 5 });
    const starting2 = u.src.start();
    u.src.stop();
    await starting2;
    expect(u.geyser.state.streams.length).toBe(0);
    // A failure after stop is not reported or retried.
    const v = source();
    v.geyser.state.failConnect = 1;
    const starting3 = v.src.start();
    v.src.stop();
    await starting3;
    await Bun.sleep(10);
    expect(v.errors).toEqual([]);
    expect(v.geyser.state.clients).toBe(1);
  });

  test("server keep-alive pings are answered; the source sends none of its own", async () => {
    const t = source();
    await t.src.start();
    const stream = t.geyser.state.stream!;
    expect(stream.writes.length).toBe(1);
    stream.push({ ping: {} });
    stream.push({ ping: {} });
    expect(stream.writes.slice(1)).toEqual([pingRequest(1), pingRequest(2)]);
    expect(t.events).toEqual([]);
    await Bun.sleep(20);
    expect(stream.writes.length).toBe(3);
    t.src.stop();
  });

  test("updates are compressed unless the endpoint rejects it, then streamed plain", async () => {
    const t = source();
    t.geyser.state.rejectCompression = new Error("failed to open subscribe stream", {
      cause: new Error("Content is compressed with `zstd` which isn't supported"),
    });
    await t.src.start();
    await until(() => t.src.connected);
    expect(t.geyser.state.compression).toEqual([true, false]);
    expect(t.errors.map(String)).toEqual([
      "Error: failed to open subscribe stream",
      "Error: Geyser endpoint rejected compression; streaming uncompressed",
    ]);
    // Later reconnects stay uncompressed; other errors never disable it.
    t.geyser.state.stream!.emit("error", new Error("reset"));
    await until(() => t.geyser.state.clients === 3 && t.src.connected);
    expect(t.geyser.state.compression).toEqual([true, false, false]);
    t.src.stop();
    const u = source({ compression: false });
    await u.src.start();
    expect(u.geyser.state.compression).toEqual([false]);
    u.src.stop();
    const v = source();
    v.geyser.state.failConnect = 1;
    await v.src.start();
    await until(() => v.src.connected);
    expect(v.geyser.state.compression).toEqual([true, true]);
    v.src.stop();
    expect(compressionRejected("grpc-status 12: unknown encoding gzip")).toBe(true);
    expect(compressionRejected(new Error("connection reset"))).toBe(false);
  });

  test("relayed (pre-normalized) events pass through", () => {
    const event = { kind: "slot" as const, slot: 5, status: "confirmed" as const };
    expect(normalize({ chainEvent: event })).toBe(event);
  });
});

