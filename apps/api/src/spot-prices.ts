import type { Hono } from "hono";
import type { JupiterSpotPrices } from "./jupiter.ts";
import { isSolanaMint, SPOT_BATCH_SIZE } from "@conditional-stocks/shared/spot-prices";

export function mountSpotPrices(app: Hono, prices: Pick<JupiterSpotPrices, "getPrices">) {
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
