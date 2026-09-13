import { MarketDataError, type NormalizedPolymarketMarket } from "@conditional-stocks/market-data";
import type { Hex } from "viem";

export interface MetadataSnapshot {
  fetchedAtMs: string;
  normalized: NormalizedPolymarketMarket;
  rawHash: Hex;
  rawPayload: unknown;
  snapshotId: string;
}

export interface SubscriptionRecord {
  conditionId: Hex;
  gammaMarketId: string;
  metadataSnapshotId: string;
  yesTokenId: string;
}

export class PolymarketIngestorClient {
  constructor(
    readonly baseUrl: string,
    readonly token: string,
  ) {}

  fetchMetadata(gammaMarketId: string): Promise<MetadataSnapshot> {
    return this.#internal<MetadataSnapshot>("/internal/metadata/fetch", {
      gammaMarketId,
    });
  }

  track(metadataSnapshotId: string): Promise<SubscriptionRecord> {
    return this.#internal<SubscriptionRecord>("/internal/subscriptions", {
      metadataSnapshotId,
    });
  }

  async snapshot(snapshotId: string): Promise<MetadataSnapshot> {
    return this.#get<MetadataSnapshot>(
      `/internal/metadata/snapshots/${encodeURIComponent(snapshotId)}`,
      true,
    );
  }

  probability(conditionId: Hex): Promise<unknown> {
    return this.#get(`/v1/polymarket/conditions/${conditionId}/probability`, false);
  }

  metadata(conditionId: Hex): Promise<MetadataSnapshot> {
    return this.#get(`/v1/polymarket/conditions/${conditionId}/metadata`, false);
  }

  async #internal<T>(path: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        body: JSON.stringify(body),
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new MarketDataError(
        "POLYMARKET_INGESTOR_UNAVAILABLE",
        error instanceof Error ? error.message : String(error),
        503,
      );
    }
    return this.#response<T>(response);
  }

  async #get<T>(path: string, internal: boolean): Promise<T> {
    let response: Response;
    try {
      response = await fetch(
        `${this.baseUrl}${path}`,
        { ...(internal ? { headers: { authorization: `Bearer ${this.token}` } } : {}),redirect:"error",signal:AbortSignal.timeout(15_000) },
      );
    } catch (error) {
      throw new MarketDataError(
        "POLYMARKET_INGESTOR_UNAVAILABLE",
        error instanceof Error ? error.message : String(error),
        503,
      );
    }
    return this.#response<T>(response);
  }

  async #response<T>(response: Response): Promise<T> {
    const body = (await response.json()) as T & { error?: { message?: string } };
    if (!response.ok) {
      throw new MarketDataError(
        "POLYMARKET_INGESTOR_ERROR",
        body.error?.message ?? `ingestor returned ${response.status}`,
        response.status >= 500 ? 503 : response.status,
      );
    }
    return body;
  }
}
