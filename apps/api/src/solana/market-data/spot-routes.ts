import {
  isSolanaMint,
  SPOT_BATCH_SIZE,
  type SpotPrice,
  sharePriceUsd,
} from "@conditional-stocks/shared/spot-prices";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { JupiterSpotPrices } from "../../integrations/jupiter/prices.ts";

export function mountSpotPrices(app: Hono, prices: Pick<JupiterSpotPrices, "getPrices">) {
  let streams = 0;
  app.get("/v1/spot-prices/stream", (c) => {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("X-Accel-Buffering", "no");
    const mints = [...new Set((c.req.query("mints") ?? "").split(","))];
    if (!mints.length || mints.length > SPOT_BATCH_SIZE || mints.some((m) => !isSolanaMint(m)))
      return c.json({ error: "Invalid spot subscription" }, 400);
    if (streams >= 2000) return c.json({ error: "Stream capacity reached" }, 503);
    return streamSSE(c, async (stream) => {
      streams++;
      try {
        while (!stream.aborted) {
          try {
            // JupiterSpotPrices coalesces overlapping mint batches across clients.
            await stream.writeSSE({
              event: "prices",
              data: JSON.stringify(await prices.getPrices(mints)),
            });
          } catch {
            await stream.writeSSE({ event: "unavailable", data: "{}" });
          }
          await stream.sleep(15_000);
        }
      } finally {
        streams--;
      }
    });
  });
  // This public GET carries no wallet/session information and accepts no upstream URL.
  app.get("/v1/spot-prices", async (c) => {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Cache-Control", "no-store");
    const queries = c.req.queries("mints");
    const mints = queries?.length === 1 ? queries[0]!.split(",") : [];
    if (
      !mints.length ||
      mints.length > SPOT_BATCH_SIZE ||
      mints.some((mint) => !isSolanaMint(mint))
    )
      return c.json(
        { error: { message: "Supply 1–50 canonical Solana mint addresses in mints" } },
        400,
      );
    return c.json(await prices.getPrices(mints));
  });
}

/** One multi-issuer market's quote and issuer legs, with each leg's live
 * ScaledUiAmount multiplier (null when issuer state is unreadable). */
export interface MarketSpotSource {
  quoteMint: string;
  bases: {
    collateral: number;
    mint: string;
    multiplierValue: number | null;
    tradable: boolean | null;
    halt: string | null;
  }[];
}

/** `GET /v1/markets/:id/spot-prices`: reference prices of a market's quote and
 * every issuer leg in one Jupiter batch, plus `sharePriceUsd` per leg (token
 * price / live multiplier), so issuers of one asset are directly comparable.
 * Display/reference only; never settlement or execution authority. */
export function mountMarketSpotPrices(
  app: Hono,
  prices: Pick<JupiterSpotPrices, "getPrices">,
  market: (id: string) => Promise<MarketSpotSource>,
) {
  app.get("/v1/markets/:id/spot-prices", async (c) => {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Cache-Control", "no-store");
    const id = c.req.param("id");
    if (!isSolanaMint(id)) return c.json({ error: { message: "Invalid market address" } }, 400);
    const source = await market(id);
    const mints = [...new Set([source.quoteMint, ...source.bases.map((b) => b.mint)])];
    const response = await prices.getPrices(mints);
    const price = (mint: string): SpotPrice | null =>
      response.prices.find((p) => p.mint === mint) ?? null;
    return c.json({
      ...response,
      marketId: id,
      quote: price(source.quoteMint),
      bases: source.bases.map((b) => {
        const spot = price(b.mint);
        return {
          ...b,
          spot,
          sharePriceUsd:
            b.multiplierValue === null
              ? null
              : sharePriceUsd(spot, b.multiplierValue, response.asOf * 1000),
        };
      }),
    });
  });
}
