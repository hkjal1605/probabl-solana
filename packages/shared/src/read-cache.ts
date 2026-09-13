/** Process-local, bounded single-flight cache for advisory GET reads only.
 * Never use for transaction preparation, authorization or custody decisions.
 * Expired successes are never served on error. Rejections are briefly shared to
 * prevent a failed upstream from receiving a new request from every caller.
 */
export class ReadCache {
  private entries = new Map<
    string,
    { expires: number; pending: boolean; value: Promise<unknown> }
  >();
  private lastNow = 0;
  constructor(
    private readonly ttlMs = 2000,
    private readonly maxEntries = 256,
    private readonly failureTtlMs = 1000,
    private readonly now = Date.now,
  ) {}
  get<T>(key: string, read: () => Promise<T>): Promise<T> {
    const now = this.now();
    if (now < this.lastNow) this.entries.clear();
    this.lastNow = now;
    const cached = this.entries.get(key);
    if (cached && (cached.pending || cached.expires > now)) return cached.value as Promise<T>;
    if (cached) this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      const evict = [...this.entries].find(([, entry]) => !entry.pending)?.[0];
      if (evict !== undefined) this.entries.delete(evict);
      else return Promise.reject(new Error("Read capacity reached; retry shortly"));
    }
    const entry = { expires: now, pending: true, value: Promise.resolve<unknown>(undefined) };
    entry.value = Promise.resolve()
      .then(read)
      .then(
        (value) => {
          entry.pending = false;
          entry.expires = this.now() + this.ttlMs;
          return value;
        },
        (error) => {
          entry.pending = false;
          entry.expires = this.now() + this.failureTtlMs;
          throw error;
        },
      );
    this.entries.set(key, entry);
    return entry.value as Promise<T>;
  }
}
