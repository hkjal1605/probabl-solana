import { isSolanaMint, SPOT_BATCH_SIZE } from "@conditional-stocks/shared/spot-prices";
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
