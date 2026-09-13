import { describe, expect, test } from "bun:test";
import { createTransport, type Transport } from "viem";
import { pacedTransport, requestAdmission } from "../rpc-pacing.ts";

describe("RPC pacing", () => {
  test("concurrent callers receive evenly spaced slots", async () => {
    let now = 0;
    const admit = requestAdmission(
      25,
      () => now,
      async (ms) => {
        now += ms;
      },
    );
    const times: number[] = [];
    await Promise.all(
      Array.from({ length: 40 }, async () => {
        await admit();
        times.push(now);
      }),
    );
    expect(times).toEqual(Array.from({ length: 40 }, (_, index) => index * 40));
  });
  test("event-loop stalls do not release accumulated bursts", async () => {
    let now = 0;
    const admit = requestAdmission(
      20,
      () => now,
      async (ms) => {
        now += ms + 200;
      },
    );
    await admit();
    await admit();
    const second = now;
    await admit();
    expect(now - second).toBeGreaterThanOrEqual(50);
  });
  test("rejects invalid configured rates", () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1001])
      expect(() => requestAdmission(value)).toThrow();
  });
  test("admission does not serialize responses or swallow RPC errors", async () => {
    const release: Array<(value: string) => void> = [];
    const base: Transport = () =>
      createTransport({
        key: "test",
        name: "test",
        type: "custom",
        request: async () => new Promise<string>((resolve) => release.push(resolve)),
      });
    let now = 0;
    const transport = pacedTransport(
      base,
      requestAdmission(
        10,
        () => now,
        async (ms) => {
          now += ms;
        },
      ),
    )({});
    const first = transport.request({ method: "eth_chainId" });
    const second = transport.request({ method: "eth_chainId" });
    for (let tick = 0; tick < 12; tick++) await Promise.resolve();
    expect(release).toHaveLength(2);
    const [releaseFirst, releaseSecond] = release;
    if (!releaseFirst || !releaseSecond) throw new Error("Both requests must be in flight");
    releaseSecond("second");
    expect(await second).toBe("second");
    releaseFirst("first");
    expect(await first).toBe("first");
    const failing: Transport = () =>
      createTransport({
        key: "test",
        name: "test",
        type: "custom",
        retryCount: 0,
        request: async () => {
          throw new Error("provider unavailable");
        },
      });
    await expect(
      pacedTransport(failing, async () => {})({}).request({ method: "eth_chainId" }),
    ).rejects.toThrow("provider unavailable");
  });
});
