import type { Hono } from "hono";
import type { Authenticate } from "../auth/routes.ts";
import type { Faucet } from "./faucet.ts";

/** Devnet asset faucet: public status, one authenticated claim per wallet. */
export function mountFaucet(app: Hono, faucet: Faucet | null, authenticate: Authenticate) {
  app.get("/v1/faucet/status", async (c) => {
    c.header("Cache-Control", "no-store");
    const owner = c.req.query("owner");
    if (!faucet) return c.json({ available: false, claimed: false });
    if (!owner) return c.json({ available: true, claimed: false });
    return c.json(await faucet.status(owner));
  });
  app.post("/v1/faucet/claim", async (c) => {
    const owner = await authenticate(c.req.header("authorization"));
    if (!faucet) return c.json({ error: { message: "The devnet faucet is not available" } }, 503);
    return c.json(await faucet.claim(owner));
  });
}
