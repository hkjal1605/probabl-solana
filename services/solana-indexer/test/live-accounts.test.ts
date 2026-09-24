import { describe, expect, test } from "bun:test";
import { AccountStore, isTombstone } from "../src/live/accounts.ts";
import { version } from "./live-fixture.ts";

const P = "program";
const data = (text: string) => Buffer.from(text);
const read = (store: AccountStore, commitment: "confirmed" | "finalized", address: string) =>
  store.get(commitment, address)?.data.toString();

function base() {
  const store = new AccountStore();
  store.bootstrap(10, [
    ["a", version(10, data("a0"), P)],
    ["closed", version(10, data(""), P, 0n, 0n)],
  ]);
  return store;
}

describe("commitment-aware account store", () => {
  test("bootstrap is the finalized and confirmed base; tombstones are hidden", () => {
    const store = base();
    expect([store.finalizedSlot, store.confirmedSlot]).toEqual([10, 10]);
    expect(read(store, "confirmed", "a")).toBe("a0");
    expect(read(store, "finalized", "a")).toBe("a0");
    expect(store.get("confirmed", "closed")).toBeUndefined();
    expect([...store.entries("finalized")].map(([k]) => k)).toEqual(["a"]);
    expect([...store.entries("confirmed")].map(([k]) => k)).toEqual(["a"]);
    expect(isTombstone(version(1, data(""), P, 0n, 0n))).toBe(true);
    // A new bootstrap discards everything newer.
    store.account("a", version(11, data("a1"), P));
    store.bootstrap(20, []);
    expect(store.backlog()).toEqual({ staged: 0, pending: 0 });
    expect(store.get("confirmed", "a")).toBeUndefined();
  });

  test("updates stay invisible until their slot is confirmed, then commit atomically", () => {
    const store = base();
    store.account("a", version(9, data("stale"), P)); // At or before the finalized base.
    store.account("a", version(11, data("a1"), P, 1n));
    store.account("a", version(11, data("a1-late"), P, 3n));
    store.account("a", version(11, data("a1-older"), P, 2n)); // Lower write version loses.
    store.account("b", version(12, data("b2"), P));
    expect(read(store, "confirmed", "a")).toBe("a0");
    expect(store.backlog()).toEqual({ staged: 2, pending: 0 });
    const result = store.confirm(11);
    expect(result).toEqual({ commitment: "confirmed", slot: 11, changed: new Set(["a"]), rebuilt: false });
    expect(read(store, "confirmed", "a")).toBe("a1-late");
    expect(read(store, "confirmed", "b")).toBeUndefined();
    expect(read(store, "finalized", "a")).toBe("a0");
    // A duplicate (replayed) update changes nothing.
    store.account("a", version(11, data("a1-late"), P, 3n));
    expect(store.confirm(11).changed.size).toBe(0);
    expect(store.confirm(12).changed).toEqual(new Set(["b"]));
    expect(store.confirmedSlot).toBe(12);
    // Confirming an older slot never moves the confirmed slot backwards.
    store.confirm(5);
    expect(store.confirmedSlot).toBe(12);
  });

  test("finalization folds the finalized chain and prunes abandoned forks", () => {
    const store = base();
    store.parent(11, 10);
    store.parent(12, 10); // Fork: 11 and 12 both descend from 10.
    store.parent(13, 12);
    store.account("a", version(11, data("fork"), P));
    store.account("b", version(12, data("b12"), P));
    store.account("c", version(13, data("c13"), P));
    store.confirm(11);
    store.confirm(13);
    expect(read(store, "confirmed", "a")).toBe("fork");
    const { finalized, confirmed, onChain } = store.finalize(13);
    expect(finalized).toEqual({ commitment: "finalized", slot: 13, changed: new Set(["b", "c"]), rebuilt: false });
    expect([11, 12, 13].map(onChain)).toEqual([false, true, true]);
    expect(read(store, "finalized", "a")).toBe("a0");
    // The confirmed view is rebuilt without the abandoned slot 11.
    expect(confirmed!.rebuilt).toBe(true);
    expect(confirmed!.changed).toEqual(new Set(["a"]));
    expect(read(store, "confirmed", "a")).toBe("a0");
    expect(store.finalizedSlot).toBe(13);
    // Finalizing an older slot is a no-op.
    const stale = store.finalize(12);
    expect(stale.finalized).toEqual({ commitment: "finalized", slot: 12, changed: new Set(), rebuilt: false });
    expect(stale.onChain(12)).toBe(false);
  });

  test("without complete parentage every confirmed slot is kept", () => {
    const store = base();
    store.parent(12, 11); // 11's parent is unknown: the walk has a gap.
    store.account("a", version(11, data("a11"), P));
    store.account("b", version(12, data("b12"), P));
    store.account("c", version(14, data("c14"), P));
    store.confirm(12);
    // Finalization commits anything still staged up to the slot.
    store.account("d", version(13, data("d13"), P));
    const { finalized, confirmed, onChain } = store.finalize(13);
    expect(onChain(11)).toBe(true);
    expect(confirmed).toEqual({ commitment: "confirmed", slot: 13, changed: new Set(["d"]), rebuilt: false });
    expect(finalized.changed).toEqual(new Set(["a", "b", "d"]));
    expect(read(store, "finalized", "c")).toBeUndefined();
    expect(store.backlog()).toEqual({ staged: 1, pending: 0 });
    // A later slot finalizing directly on the base keeps the confirmed slot monotone.
    store.confirm(14);
    store.parent(20, 14);
    const next = store.finalize(20);
    expect(next.finalized.changed).toEqual(new Set(["c"]));
    expect(next.confirmed).toBeUndefined();
    expect(store.confirmedSlot).toBe(20);
  });

  test("dead slots drop their updates and rebuild the confirmed view when committed", () => {
    const store = base();
    store.account("a", version(11, data("dead"), P));
    expect(store.dead(11)).toBeUndefined(); // Only staged: nothing visible changed.
    store.account("a", version(12, data("a12"), P));
    store.account("b", version(13, data("b13"), P));
    store.account("b", version(14, data("b14"), P));
    store.confirm(14);
    const rebuilt = store.dead(12)!;
    expect(rebuilt).toEqual({ commitment: "confirmed", slot: 14, changed: new Set(["a"]), rebuilt: true });
    expect(read(store, "confirmed", "a")).toBe("a0");
    expect(read(store, "confirmed", "b")).toBe("b14");
  });

  test("closed accounts are tombstones that still order against later writes", () => {
    const store = base();
    store.account("a", version(11, data(""), P, 1n, 0n));
    store.confirm(11);
    expect(store.get("confirmed", "a")).toBeUndefined();
    store.account("a", version(12, data("reopened"), P));
    store.confirm(12);
    expect(read(store, "confirmed", "a")).toBe("reopened");
  });

  test("seeded values never override a newer streamed version", () => {
    const store = base();
    store.seed("mint", version(10, data("seed"), "token"));
    expect(read(store, "finalized", "mint")).toBe("seed");
    store.account("mint", version(11, data("stream"), "token"));
    store.confirm(11);
    store.seed("mint", version(10, data("old-seed"), "token", 2n));
    expect(read(store, "confirmed", "mint")).toBe("stream");
    // The finalized view only had the older seed, so a newer read replaces it.
    expect(read(store, "finalized", "mint")).toBe("old-seed");
  });
});
