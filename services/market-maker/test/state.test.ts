import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateFile, initialState, validateState } from "../src/state";
test("durable state retains drawdown, funding and spending latches across restarts; one process per state", () => {
  const path = join(mkdtempSync(join(tmpdir(), "probabl-mm-test-")), "state.json"),
    file = new StateFile(path, "wallet:devnet");
  try {
    file.state.markets.market = { halted: true, fundStarted: true, peak: "10000" };
    file.state.spent = "5000";
    file.save();
    expect(() => new StateFile(path, "wallet:devnet")).toThrow();
    expect(statSync(path).mode & 0o077).toBe(0);
  } finally {
    file.close();
  }
  const reopened = new StateFile(path, "wallet:devnet");
  try {
    expect(reopened.state.markets.market?.halted).toBe(true);
    expect(reopened.state.spent).toBe("5000");
  } finally {
    reopened.close();
  }
  expect(() => new StateFile(path, "other-wallet:mainnet")).toThrow();
  expect(readFileSync(path, "utf8")).not.toContain("PRIVATE_KEY");
});
test("corrupt or wrong-domain risk state never silently resets", () => {
  for (const patch of [
    { spent: "-1" },
    { lastSlot: NaN },
    { scope: "different" },
    { markets: { m: { halted: "false" } } },
    { markets: { m: { priceUnit: "raw" } } },
    { pending: { signature: "bad", lastValidBlockHeight: 1 } },
  ])
    expect(() => validateState({ ...initialState("test"), ...patch }, "test")).toThrow();
});
