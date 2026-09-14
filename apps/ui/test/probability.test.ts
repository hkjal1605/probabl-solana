import { expect, test } from "bun:test";
import {
  expireProbability,
  parseProbabilityMessage,
  probabilityStreamUrl,
} from "../src/services/probability";

test("probability streams default to the deployed WSS endpoint and preserve explicit overrides", () => {
  expect(probabilityStreamUrl("0x1234")).toBe(
    "wss://api-solana.probabl.trade/v1/polymarket/conditions/0x1234/stream",
  );
  expect(probabilityStreamUrl("0x1234", "ws://127.0.0.1:42073/")).toBe(
    "ws://127.0.0.1:42073/v1/polymarket/conditions/0x1234/stream",
  );
  expect(probabilityStreamUrl("condition/with?parts")).toBe(
    "wss://api-solana.probabl.trade/v1/polymarket/conditions/condition%2Fwith%3Fparts/stream",
  );
});
test("probability stream origins cannot carry credentials, paths, queries or non-WebSocket schemes", () => {
  for (const value of [
    "",
    "invalid",
    "https://api.test",
    "wss://u:secret@api.test",
    "wss://api.test/v1",
    "wss://api.test?key=secret",
    "wss://api.test/#fragment",
  ])
    expect(() => probabilityStreamUrl("condition", value)).toThrow();
  expect(() => probabilityStreamUrl("")).toThrow();
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
  expect(
    parseProbabilityMessage({ topic: `probability.${id}`, value: tick }, id)
      .value,
  ).toBe(0.5);
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
  const view = parseProbabilityMessage(
    { topic: `probability.${id}`, value: tick },
    id,
  );
  expect(
    expireProbability(view, Number(tick.observedAtMs) + 31000).quality,
  ).toBe("stale");
  expect(() =>
    parseProbabilityMessage({ topic: "wrong", value: tick }, id),
  ).toThrow();
});
