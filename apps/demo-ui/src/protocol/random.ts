// Deterministic pseudo-randomness so a reload rebuilds the same starting book.

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Small-state xorshift generator: fast, stable, and dependency free. */
export function createRandom(seed: number | string) {
  let state = (typeof seed === "string" ? hashString(seed) : seed >>> 0) || 0x9e3779b9;
  const next = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
  return {
    next,
    between: (min: number, max: number) => min + next() * (max - min),
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)] as T,
    chance: (probability: number) => next() < probability,
    /** Approximately normal, for price walks that do not look like a sawtooth. */
    normal: () => (next() + next() + next() + next() + next() + next() - 3) / 1.5,
  };
}

export type Random = ReturnType<typeof createRandom>;

/** Base58 identifier of a requested length, stable for the same seed. */
export function base58Id(seed: string, length = 44): string {
  let random = createRandom(seed);
  let out = "";
  for (let index = 0; index < length; index++) {
    if (index % 8 === 0) random = createRandom(`${seed}:${index}`);
    out += BASE58[Math.floor(random.next() * BASE58.length)];
  }
  return out;
}

/** Fresh identifier for a newly created order, fill, or transaction. */
export function uniqueId(prefix: string, length = 44): string {
  return base58Id(`${prefix}:${Date.now()}:${Math.random()}`, length);
}
