import { expect, test } from "bun:test";
import { creationTimes } from "../src/history";

test("finalized creation event seconds become ISO times; invalid values never reorder markets", () => {
  const times = creationTimes([
    { market: "a", block_time: "1789370400" },
    { market: "b", block_time: "0" },
    { market: "c", block_time: "-1" },
    { market: "d", block_time: "999999999999999999999" },
  ]);
  expect(times.get("a")).toBe(new Date(1789370400 * 1000).toISOString());
  expect([...times.keys()]).toEqual(["a"]);
});
