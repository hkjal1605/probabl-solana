import { z } from "zod";

const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export class TradingUnavailableError extends Error {
  override readonly name = "TradingUnavailableError";
}

export interface TradingSafety {
  assertCanTrade(marketIds: readonly string[]): Promise<void>;
}

export const safetyConfigSchema = z.object({
  ROBINHOOD_CHAIN_ID: z.coerce.number().int().positive(),
  EXCHANGE_ADDRESS: address,
  INDEXER_URL: z.url().default("http://127.0.0.1:42069"),
  RECONCILIATION_URL: z.url().default("http://127.0.0.1:42070"),
  SAFETY_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5_000),
  INDEXER_MAX_HEAD_AGE_SECONDS: z.coerce.number().int().positive().default(30),
  RECONCILIATION_MAX_AGE_MS: z.coerce.number().int().positive().default(120_000),
  RECONCILIATION_MAX_DEEP_AGE_MS: z.coerce.number().int().positive().default(90_000_000),
});

export const indexedHealthSchema = z.object({
  chainId: z.number().int().positive(),
  exchange: address,
  healthy: z.literal(true),
  protocolVersion: z.literal(2),
  head: z.object({
    indexedBlock: decimal,
    indexedBlockHash: hash,
    indexedBlockTimestamp: decimal,
    confirmedBlock: decimal,
    finalizedBlock: decimal,
  }),
});

const reportSchema = z.object({
  chainId: z.number().int().positive(),
  completedAt: z.iso.datetime(),
  deep: z.boolean(),
  indexedBlock: decimal,
  indexedBlockHash: hash,
  projectionVersion: z.literal(3),
  status: z.enum(["ok", "mismatch"]),
});
const controlSchema = z.object({
  chainId: z.number().int().positive(),
  exchange: address,
  latestReport: reportSchema,
  latestDeepReport: reportSchema.extend({ deep: z.literal(true) }),
  signals: z.array(z.object({ scope: z.string().min(1) })),
});

/** No positive caching: every admission and broadcast rechecks the control plane. */
export class HttpTradingSafety implements TradingSafety {
  readonly config: z.infer<typeof safetyConfigSchema>;

  constructor(
    environment: Record<string, string | undefined>,
    readonly request: typeof fetch = fetch,
    readonly now: () => number = Date.now,
  ) {
    this.config = safetyConfigSchema.parse(environment);
    for (const value of [this.config.INDEXER_URL, this.config.RECONCILIATION_URL]) {
      if (!["http:", "https:"].includes(new URL(value).protocol))
        throw new Error("Safety URLs must use HTTP(S)");
    }
  }

  async assertCanTrade(marketIds: readonly string[]): Promise<void> {
    try {
      const [head, control] = await Promise.all([
        this.#json(`${this.config.INDEXER_URL}/indexer/health`).then((value) =>
          indexedHealthSchema.parse(value),
        ),
        this.#json(`${this.config.RECONCILIATION_URL}/freeze-signals`).then((value) =>
          controlSchema.parse(value),
        ),
      ]);
      for (const identity of [head, control]) {
        if (
          identity.chainId !== this.config.ROBINHOOD_CHAIN_ID ||
          identity.exchange.toLowerCase() !== this.config.EXCHANGE_ADDRESS.toLowerCase()
        ) {
          throw new Error("safety service deployment identity mismatch");
        }
      }
      this.#age(
        Number(head.head.indexedBlockTimestamp) * 1000,
        this.config.INDEXER_MAX_HEAD_AGE_SECONDS * 1000,
        "indexed head",
      );
      for (const [report, maxAge] of [
        [control.latestReport, this.config.RECONCILIATION_MAX_AGE_MS],
        [control.latestDeepReport, this.config.RECONCILIATION_MAX_DEEP_AGE_MS],
      ] as const) {
        if (report.chainId !== this.config.ROBINHOOD_CHAIN_ID)
          throw new Error("reconciliation chain mismatch");
        this.#age(Date.parse(report.completedAt), maxAge, "reconciliation");
        // A rewind or stale control database must not greenlight a different history.
        const indexed = BigInt(head.head.indexedBlock);
        const checked = BigInt(report.indexedBlock);
        if (checked > indexed)
          throw new Error("reconciliation is ahead of canonical indexer state");
        const anchor = (await this.#json(
          `${this.config.INDEXER_URL}/internal/canonical-block/${report.indexedBlock}`,
        )) as { hash?: string };
        if (anchor.hash?.toLowerCase() !== report.indexedBlockHash.toLowerCase())
          throw new Error("reconciliation anchor was reorganized");
      }
      const scopes = new Set(marketIds.map((id) => `market:${id.toLowerCase()}`));
      for (const signal of control.signals) {
        const scope = signal.scope.toLowerCase();
        if (!/^market:0x[0-9a-f]{64}$/.test(scope) || scopes.has(scope) || marketIds.length === 0) {
          throw new Error(`reconciliation freeze: ${signal.scope}`);
        }
      }
      if (
        (control.latestReport.status === "mismatch" ||
          control.latestDeepReport.status === "mismatch") &&
        control.signals.length === 0
      ) {
        throw new Error("reconciliation mismatch without usable scope information");
      }
    } catch (error) {
      throw new TradingUnavailableError(
        error instanceof Error ? error.message : "Trading safety unavailable",
      );
    }
  }

  #age(at: number, maximum: number, label: string): void {
    const age = this.now() - at;
    if (!Number.isSafeInteger(at) || age < -5_000 || age > maximum)
      throw new Error(`${label} is stale or has an invalid timestamp`);
  }

  async #json(url: string): Promise<unknown> {
    const response = await this.request(url, {
      signal: AbortSignal.timeout(this.config.SAFETY_REQUEST_TIMEOUT_MS),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`safety service unavailable (${response.status})`);
    return response.json();
  }
}
