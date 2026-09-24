import { expect, test } from "bun:test";
import { Hono } from "hono";
import { PublicKey } from "@solana/web3.js";
import { changedTopics, createIndexStream } from "../src/stream";
import type { Snapshot } from "../src/projection";
import { bn, UNIT_MULTIPLIER, type LiveLeg } from "@conditional-stocks/solana-client";
import { custodyFixture } from "./custody-fixture";
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
test("leg listings, delist/relist toggles and live issuer state invalidate the market", () => {
  const { s } = custodyFixture(2);
  const [market, m] = [...s.markets][0]!;
  const before = { ...s, rawAccounts: [{ address: market, data: "before" }] } as Snapshot;
  const listed = { ...m, legs: m.legs.map((l) => ({ ...l })), mints: [...m.mints] };
  const next = {
    ...s,
    slot: 101,
    markets: new Map([...s.markets].map(([id, value]) => [id, id === market ? listed : value])),
    rawAccounts: [{ address: market, data: "after" }],
  } as Snapshot;
  // A third issuer leg is listed and leg 1 is delisted in the same interval.
  listed.bases = 3;
  listed.legs[2] = { scale: bn(1000), multiplier: bn(UNIT_MULTIPLIER), active: true };
  listed.mints[9] = PublicKey.unique();
  listed.legs[0] = { ...listed.legs[0]!, active: false };
  const update = changedTopics(before, next);
  expect(update.markets).toEqual([market]);
  expect(update.marketEvents).toEqual([
    { marketId: market, kind: "base-active", collateral: 1, active: false },
    {
      marketId: market,
      kind: "base-listed",
      collateral: 3,
      mint: listed.mints[9]!.toBase58(),
      scale: "1000",
    },
  ]);
  // No account change, but an issuer paused its token.
  const live = (paused: boolean) =>
    new Map([
      [
        market,
        {
          1: {
            multiplier: UNIT_MULTIPLIER,
            multiplierValue: 1,
            paused,
            vaultFrozen: false,
            tradable: !paused,
            halt: paused ? "issuer-paused" : null,
          } as unknown as LiveLeg,
        },
      ],
    ]);
  const quiet = changedTopics({ ...s, legs: live(false) }, { ...s, slot: 102, legs: live(true) });
  expect(quiet.markets).toEqual([market]);
  expect(quiet.marketEvents).toEqual([]);
});

async function frames(reader: ReadableStreamDefaultReader<Uint8Array>, count: number) {
  const out: { event: string; data: any }[] = [];
  let buffer = "";
  while (out.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += new TextDecoder().decode(value);
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
      const data = /^data: (.*)$/m.exec(block)?.[1];
      out.push({ event, data: data ? JSON.parse(data) : undefined });
    }
  }
  return out;
}

test("SSE pushes each commit immediately and coalesces bursts for slow readers", async () => {
  const { s } = custodyFixture(1);
  const [market] = [...s.markets.keys()];
  s.config.paused = false;
  const app = new Hono(), hub = createIndexStream();
  hub.mount(app, () => s);
  const reader = (await app.request("/stream")).body!.getReader();
  const [reset] = await frames(reader, 1);
  expect(reset!.event).toBe("reset");
  expect(reset!.data.readiness[market!]).toMatchObject({ healthy: true, reason: "ready", chain: "solana" });
  // Two commits before the reader wakes merge into one invalidation.
  hub.publish({ slot: 2, observedAt: 1, markets: ["a"], owners: ["o1"], marketEvents: [] });
  hub.publish({ slot: 3, observedAt: 2, markets: ["b", "a"], owners: [], marketEvents: [] });
  const [update] = await frames(reader, 1);
  expect(update!.event).toBe("index");
  expect(update!.data).toMatchObject({ slot: 3, markets: ["a", "b"], owners: ["o1"] });
  const started = Date.now();
  hub.publish({ slot: 4, observedAt: 3, markets: ["c"], owners: [], marketEvents: [] });
  expect((await frames(reader, 1))[0]!.data.markets).toEqual(["c"]);
  expect(Date.now() - started).toBeLessThan(500);
  await reader.cancel();
});

test("SSE readiness reasons, wallet frames and unavailable recovery", async () => {
  const { s, owner } = custodyFixture(1);
  const ids = [...s.markets.keys()];
  const now = BigInt(Math.floor(Date.now() / 1000));
  s.markets.get(ids[0]!)!.state = 1;
  s.markets.get(ids[1]!)!.terms.trading_cutoff = bn(Number(now - 10n));
  let available = true;
  const touched: string[] = [];
  const wallet = { observedAt: 5, balances: {} };
  let peeked: typeof wallet | undefined;
  const wallets = {
    touch: (o: string) => touched.push(o),
    peek: () => peeked,
    get: async () => {
      peeked = wallet;
      return wallet;
    },
  };
  const app = new Hono(), hub = createIndexStream();
  hub.mount(
    app,
    () => {
      if (!available) throw new Error("index unavailable");
      return s;
    },
    wallets as never,
  );
  const reader = (await app.request("/stream?owner=" + owner.toBase58())).body!.getReader();
  const [first] = await frames(reader, 1);
  expect(first!.data.readiness[ids[0]!].reason).toBe("scheduled");
  expect(first!.data.readiness[ids[1]!].reason).toBe("closed");
  expect(first!.data.wallet).toBeUndefined();
  expect(touched).toContain(owner.toBase58());
  // The wallet image is sent once when it first appears.
  hub.publish({ slot: 2, observedAt: 1, markets: [], owners: [], marketEvents: [] });
  const [withWallet] = await frames(reader, 1);
  expect(withWallet!.data.wallet).toEqual(wallet);
  hub.publish({ slot: 3, observedAt: 1, markets: [], owners: [], marketEvents: [] });
  expect((await frames(reader, 1))[0]!.data.wallet).toBeUndefined();
  // Unavailable index: an explicit frame, then a reset once it recovers.
  available = false;
  hub.publish({ slot: 4, observedAt: 1, markets: [], owners: [], marketEvents: [] });
  expect((await frames(reader, 1))[0]!.event).toBe("unavailable");
  available = true;
  s.config.paused = true;
  const [recovered] = await frames(reader, 1);
  expect(recovered!.event).toBe("reset");
  expect(recovered!.data.readiness[ids[0]!].reason).toBe("paused");
  s.config.paused = false;
  s.markets.get(ids[0]!)!.state = 2;
  s.markets.get(ids[0]!)!.terms.trading_open = bn(Number(now + 1000n));
  hub.publish({ slot: 5, observedAt: 1, markets: [], owners: [], marketEvents: [] });
  expect((await frames(reader, 1))[0]!.data.readiness[ids[0]!].reason).toBe("scheduled");
  await reader.cancel();
});
