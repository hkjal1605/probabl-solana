import { expect, test } from "bun:test";
import { API_URL } from "../src/services/constants";
import { subscribeProbability } from "../src/services/probability-stream";

test("probability subscribers share an API SSE connection and close on final unsubscribe", () => {
  const original = globalThis.EventSource;
  const sources: FakeSource[] = [];
  class FakeSource extends EventTarget {
    closed = false;
    onerror: (() => void) | null = null;
    constructor(readonly url: string) {
      super();
      sources.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  globalThis.EventSource = FakeSource as unknown as typeof EventSource;
  const condition = `0x${"11".repeat(32)}`;
  const received: number[] = [];
  const stops: Array<() => void> = [];
  try {
    const update = (value: { value: number | null }) => {
      if (value.value !== null) received.push(value.value);
    };
    stops.push(subscribeProbability(condition, update, () => {}));
    stops.push(
      subscribeProbability(
        condition,
        (value) => update(value),
        () => {},
      ),
    );
    expect(sources).toHaveLength(1);
    const source = sources[0];
    if (!source) throw new Error("Missing SSE connection");
    expect(source.url).toBe(`${API_URL}/v1/probabilities/${condition}/stream`);
    source.dispatchEvent(
      new MessageEvent("probability", {
        data: JSON.stringify({
          topic: `probability.${condition}`,
          value: {
            conditionId: condition,
            quality: "valid",
            midpointX6: "280000",
            bestBidX6: "270000",
            bestAskX6: "290000",
            observedAtMs: String(Date.now()),
          },
        }),
      }),
    );
    expect(received).toEqual([0.28, 0.28]);
    stops.shift()?.();
    expect(source.closed).toBe(false);
    stops.shift()?.();
    expect(source.closed).toBe(true);
  } finally {
    for (const stop of stops) stop();
    globalThis.EventSource = original;
  }
});
