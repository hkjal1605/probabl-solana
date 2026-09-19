import {
  expireSpotPrice,
  isSolanaMint,
  SOLANA_MAINNET_GENESIS,
  SPOT_BATCH_SIZE,
  SPOT_POLL_MS,
  type SpotPrice,
  type SpotPricesResponse,
  type SpotStatus,
  spotMapping,
} from "@conditional-stocks/shared/spot-prices";

const PRICE_URL = "https://api.jup.ag/price/v3";
const MAX_ENTRIES = 500;
const MAX_BYTES = 256 * 1024;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Tick = Pick<
  SpotPrice,
  "priceUsd" | "sourceDecimals" | "blockId" | "priceTimestamp" | "fetchedAt"
>;
type Entry = { tick?: Tick; status: SpotStatus; retryAt: number; highestBlock?: number };
const emptyTick: Tick = {
  priceUsd: null,
  sourceDecimals: null,
  blockId: null,
  priceTimestamp: null,
  fetchedAt: null,
};

export function jupiterEnvironment(env: Record<string, string | undefined>) {
  const apiKey = env.JUPITER_API_KEY?.trim() ?? "";
  if (apiKey && (!/^[\x21-\x7e]+$/.test(apiKey) || apiKey.length > 4096))
    throw new Error("Invalid JUPITER_API_KEY format (value withheld)");
  const rpcUrl = env.JUPITER_PRICE_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  try {
    const url = new URL(rpcUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error();
  } catch {
    throw new Error("JUPITER_PRICE_RPC_URL must be a mainnet HTTPS RPC URL");
  }
  return { apiKey, rpcUrl };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid price object");
  return value as Record<string, unknown>;
}
export function parseJupiterPrice(input: unknown, nowMs: number): Tick {
  const value = record(input),
    price = value.usdPrice,
    decimals = value.decimals,
    block = value.blockId;
  if (
    typeof price !== "number" ||
    !Number.isFinite(price) ||
    price <= 0 ||
    typeof decimals !== "number" ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255 ||
    typeof block !== "number" ||
    !Number.isSafeInteger(block) ||
    block <= 0
  )
    throw new Error("Invalid Jupiter price, decimals or block");
  return {
    priceUsd: price,
    sourceDecimals: decimals,
    blockId: block,
    priceTimestamp: null,
    fetchedAt: Math.floor(nowMs / 1000),
  };
}
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing price response");
  let bytes = 0,
    text = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error("Oversized price response");
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Bounded cache and queue; overlapping callers share requests. At most one Jupiter
 * request/sec per API process. No wallet signer or trading dependency.
 */
export class JupiterSpotPrices {
  private cache = new Map<string, Entry>();
  private pending = new Map<string, { promise: Promise<void>; done: () => void }>();
  private queue = new Set<string>();
  private draining = false;
  private nextRequestAt = 0;
  private blockedUntil = 0;
  private blockedStatus: SpotStatus = "unavailable";
  private failures = 0;
  private lastNow = 0;
  private blockTimes = new Map<number, number>();

  constructor(
    private readonly genesisHash: string,
    private readonly settings: ReturnType<typeof jupiterEnvironment>,
    private readonly fetcher: Fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async getPrices(mints: string[]): Promise<SpotPricesResponse> {
    if (
      !mints.length ||
      mints.length > SPOT_BATCH_SIZE ||
      mints.some((mint) => !isSolanaMint(mint))
    )
      throw new Error("Supply 1–50 canonical Solana mint addresses");
    const now = this.now();
    if (now < this.lastNow) {
      this.cache.clear();
      this.blockTimes.clear();
      this.blockedUntil = 0;
      this.nextRequestAt = 0;
    }
    this.lastNow = now;
    const mappings = [...new Set(mints)].map((mint) => spotMapping(this.genesisHash, mint));
    if (this.settings.apiKey && now >= this.blockedUntil) {
      const waits = mappings.flatMap(({ sourceMint }) => {
        if (!sourceMint || now < (this.cache.get(sourceMint)?.retryAt ?? 0)) return [];
        const existing = this.pending.get(sourceMint);
        if (existing) return [existing.promise];
        if (this.pending.size >= MAX_ENTRIES) return [];
        let done!: () => void;
        const promise = new Promise<void>((resolve) => {
          done = resolve;
        });
        this.pending.set(sourceMint, { promise, done });
        this.queue.add(sourceMint);
        return [promise];
      });
      if (!this.draining && this.queue.size) {
        this.draining = true;
        void this.drain();
      }
      await Promise.all(waits);
    }
    return {
      source: "jupiter",
      sourceGenesisHash: SOLANA_MAINNET_GENESIS,
      displayOnly: true,
      genesisHash: this.genesisHash,
      asOf: Math.floor(this.now() / 1000),
      prices: mappings.map((mapping) => {
        const entry = mapping.sourceMint ? this.cache.get(mapping.sourceMint) : undefined;
        return expireSpotPrice(
          {
            ...mapping,
            ...(entry?.tick ?? emptyTick),
            status: !mapping.sourceMint
              ? "unmapped"
              : !this.settings.apiKey
                ? "not-configured"
                : this.now() < this.blockedUntil
                  ? this.blockedStatus
                  : (entry?.status ?? "unavailable"),
          },
          this.now(),
        );
      }),
    };
  }

  private put(mint: string, entry: Entry) {
    const previousBlock = this.cache.get(mint)?.highestBlock;
    this.cache.delete(mint);
    this.cache.set(mint, {
      ...entry,
      ...(previousBlock ? { highestBlock: Math.max(previousBlock, entry.highestBlock ?? 0) } : {}),
    });
    while (this.cache.size > MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
  }
  private async drain() {
    try {
      await this.sleep(10); // coalesce simultaneous callers
      while (this.queue.size) {
        const ids = [...this.queue].slice(0, SPOT_BATCH_SIZE);
        ids.forEach((id) => {
          this.queue.delete(id);
        });
        try {
          if (this.now() >= this.blockedUntil) {
            await this.sleep(Math.max(0, this.nextRequestAt - this.now()));
            this.nextRequestAt = this.now() + 1000;
            await this.refresh(ids);
          }
        } finally {
          for (const id of ids) {
            this.pending.get(id)?.done();
            this.pending.delete(id);
          }
        }
      }
    } catch {
      this.blockedUntil = this.now() + SPOT_POLL_MS;
      this.blockedStatus = "unavailable";
    } finally {
      for (const job of this.pending.values()) job.done();
      this.pending.clear();
      this.queue.clear();
      this.draining = false;
    }
  }

  private async refresh(ids: string[]) {
    let failureStatus: SpotStatus = "unavailable",
      retryMs = 0;
    try {
      const url = new URL(PRICE_URL);
      url.searchParams.set("ids", ids.join(","));
      const response = await this.fetcher(url.toString(), {
        headers: { "x-api-key": this.settings.apiKey, accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) {
        if ([401, 403].includes(response.status)) {
          failureStatus = "restricted";
          retryMs = 60_000;
        }
        if (response.status === 429) {
          const retry = response.headers.get("retry-after");
          const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : 60;
          retryMs = Math.max(60_000, Math.min(300_000, seconds * 1000));
        }
        await response.body?.cancel();
        throw new Error("Jupiter request failed");
      }
      const body = record(await boundedJson(response));
      if (Object.keys(body).some((id) => !ids.includes(id)))
        throw new Error("Unexpected price identity");
      const ticks = new Map<string, Tick>();
      for (const id of ids) {
        if (!Object.hasOwn(body, id) || body[id] === null) {
          this.put(id, { status: "unavailable", retryAt: this.now() + SPOT_POLL_MS });
          continue;
        }
        try {
          const tick = parseJupiterPrice(body[id], this.now());
          if (tick.blockId! < (this.cache.get(id)?.highestBlock ?? 0))
            throw new Error("Regressing pricing block");
          ticks.set(id, tick);
        } catch {
          this.put(id, { status: "invalid", retryAt: this.now() + SPOT_POLL_MS });
        }
      }
      const times = await this.resolveBlockTimes([
        ...new Set([...ticks.values()].map((tick) => tick.blockId!)),
      ]);
      for (const [id, tick] of ticks) {
        tick.priceTimestamp = times.get(tick.blockId!) ?? null;
        this.put(id, {
          tick,
          highestBlock: tick.blockId!,
          status: tick.priceTimestamp === null ? "age-unverified" : "available",
          retryAt: this.now() + SPOT_POLL_MS,
        });
      }
      this.failures = 0;
    } catch {
      // Never log upstream bodies, credentials, or RPC URLs (which may embed a provider key).
      this.failures = Math.min(5, this.failures + 1);
      this.blockedUntil =
        this.now() + Math.max(retryMs, Math.min(60_000, SPOT_POLL_MS * 2 ** (this.failures - 1)));
      this.blockedStatus = failureStatus;
    }
  }

  private async resolveBlockTimes(blocks: number[]): Promise<Map<number, number>> {
    const missing = blocks.filter((block) => !this.blockTimes.has(block));
    if (missing.length)
      try {
        const response = await this.fetcher(this.settings.rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(2000),
          body: JSON.stringify([
            { jsonrpc: "2.0", id: 0, method: "getGenesisHash" },
            ...missing.map((block, i) => ({
              jsonrpc: "2.0",
              id: i + 1,
              method: "getBlockTime",
              params: [block],
            })),
          ]),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error();
        }
        const data = await boundedJson(response);
        if (!Array.isArray(data) || data.length !== missing.length + 1) throw new Error();
        const rows = new Map<number, Record<string, unknown>>();
        for (const value of data) {
          const row = record(value);
          if (!Number.isInteger(row.id) || rows.has(row.id as number)) throw new Error();
          rows.set(row.id as number, row);
        }
        if (rows.get(0)?.result !== SOLANA_MAINNET_GENESIS || rows.get(0)?.error) throw new Error();
        missing.forEach((block, i) => {
          const row = rows.get(i + 1),
            at = row?.result;
          if (
            !row?.error &&
            typeof at === "number" &&
            Number.isSafeInteger(at) &&
            at > 0 &&
            at <= Math.floor(this.now() / 1000) + 5
          )
            this.blockTimes.set(block, at);
        });
        while (this.blockTimes.size > 1000)
          this.blockTimes.delete(this.blockTimes.keys().next().value!);
      } catch {
        /* Price remains displayable, explicitly age-unverified, without affecting trading. */
      }
    return new Map(
      blocks.flatMap((block) =>
        this.blockTimes.has(block) ? [[block, this.blockTimes.get(block)!]] : [],
      ),
    );
  }
}
