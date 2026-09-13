import { expect, test } from "bun:test";
import { expireProbability, parseProbabilityMessage } from "../src/lib/api/probability";

const id = `0x${"11".repeat(32)}`;
const tick = {
  conditionId: id,
  sourceHash: "unchanged",
  quality: "valid",
  midpointX6: "500000",
  bestBidX6: "480000",
  bestAskX6: "520000",
  observedAtMs: String(Date.now()),
};
test("unchanged source hash does not suppress disconnected or stale quality", () => {
  expect(parseProbabilityMessage({ topic: `probability.${id}`, value: tick }, id).value).toBe(0.5);
  expect(
    parseProbabilityMessage(
      { topic: `probability.${id}`, value: { ...tick, quality: "disconnected", midpointX6: null } },
      id,
    ).value,
  ).toBeNull();
});
test("browser locally expires a quiet feed and rejects another condition", () => {
  const view = parseProbabilityMessage({ topic: `probability.${id}`, value: tick }, id);
  expect(expireProbability(view, Number(tick.observedAtMs) + 31000).quality).toBe("stale");
  expect(() => parseProbabilityMessage({ topic: "wrong", value: tick }, id)).toThrow();
});
