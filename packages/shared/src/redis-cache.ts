import { RedisClient } from "bun";

export interface RedisCacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
}

/** Server-only JSON cache for advisory reads, never authorization or transaction state. */
export class RedisCache {
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly client: RedisCacheClient;
  private readonly owned: RedisClient | undefined;

  constructor(
    client: RedisCacheClient | string,
    private readonly namespace: string,
    private readonly onError: () => void = () => {},
  ) {
    this.owned =
      typeof client === "string"
        ? new RedisClient(client, {
            connectionTimeout: 1000,
            enableOfflineQueue: false,
            maxRetries: 2,
          })
        : undefined;
    this.client = this.owned ?? (client as RedisCacheClient);
  }

  private async bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Cache timeout")), 1000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  get<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0)
      return Promise.reject(new Error("Cache TTL must be a positive integer"));
    const cacheKey = `${this.namespace}:${key}`;
    const existing = this.pending.get(cacheKey);
    if (existing) return existing as Promise<T>;
    if (this.pending.size >= 512) return Promise.reject(new Error("Cache read capacity reached"));
    const task = this.read(cacheKey, ttlSeconds, load).finally(() => this.pending.delete(cacheKey));
    this.pending.set(cacheKey, task);
    return task;
  }

  private async read<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    try {
      const cached = await this.bounded(this.client.get(key));
      if (cached !== null) {
        const entry = JSON.parse(cached) as { expiresAt?: number; value?: T };
        if (
          typeof entry?.expiresAt === "number" &&
          entry.expiresAt > Date.now() &&
          "value" in entry
        )
          return entry.value as T;
      }
    } catch {
      this.onError();
    }
    // Failed upstream reads are never cached. Redis failure does not block fresh reads.
    const value = await load();
    const expiresAt = Date.now() + ttlSeconds * 1000;
    try {
      await this.bounded(
        this.client.set(key, JSON.stringify({ expiresAt, value }), "EX", ttlSeconds),
      );
    } catch {
      this.onError();
    }
    return value;
  }

  close() {
    this.owned?.close();
  }
}
