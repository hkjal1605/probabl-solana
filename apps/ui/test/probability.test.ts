import { expect, test } from "bun:test";
import { apiUrl } from "../src/services/constants";
import {
  expireCachedProbability,
  expireProbability,
  parseProbabilityMessage,
  probabilityStreamUrl,
} from "../src/services/probability";

test("probability streams use our API and canonical condition IDs", () => {
  const condition = `0x${"AB".repeat(32)}`;
  expect(probabilityStreamUrl(condition)).toBe(
    apiUrl(`/v1/probabilities/${condition.toLowerCase()}/stream`),
  );
  for (const value of [
    "",
    "0x1234",
    "https://gamma-api.polymarket.com",
    "../x",
    "condition/with?parts",
  ])
    expect(() => probabilityStreamUrl(value)).toThrow();
});

test("cached display allows the cache window without rewriting timestamps or promoting bad quality", () => {
  const view = parseProbabilityMessage({ topic: `probability.${id}`, value: tick }, id);
  const at = Number(tick.observedAtMs);
  expect(expireCachedProbability(view, at + 60_000)).toEqual(view);
  expect(expireCachedProbability(view, at + 90_001).quality).toBe("stale");
  expect(expireCachedProbability({ ...view, quality: "disconnected" }, at + 1000).value).toBeNull();
});

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
      {
        topic: `probability.${id}`,
        value: { ...tick, quality: "disconnected", midpointX6: null },
      },
      id,
    ).value,
  ).toBeNull();
});
test("browser locally expires a quiet feed and rejects another condition", () => {
  const view = parseProbabilityMessage({ topic: `probability.${id}`, value: tick }, id);
  expect(expireProbability(view, Number(tick.observedAtMs) + 31000).quality).toBe("stale");
  expect(() => parseProbabilityMessage({ topic: "wrong", value: tick }, id)).toThrow();
});
