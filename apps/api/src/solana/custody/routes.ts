import type { SolanaClient } from "@conditional-stocks/solana-client";
import type { Snapshot } from "@conditional-stocks/solana-indexer/projection";
import type { Hono } from "hono";
import type { Authenticate } from "../auth/routes.ts";
import { prepareVaultTransfer } from "./vault.ts";

export function mountCustody(
  app: Hono,
  client: SolanaClient,
  authenticate: Authenticate,
  readIndex: () => Promise<Snapshot>,
) {
  app.post("/v1/payouts/withdraw/prepare", async (c) => {
    const owner = await authenticate(c.req.header("authorization"));
    return c.json(
      await prepareVaultTransfer(client, await readIndex(), owner, await c.req.json(), "withdraw"),
    );
  });
  for (const action of ["deposit", "withdraw"] as const)
    app.post(`/v1/vault/${action}/prepare`, async (c) => {
      const owner = await authenticate(c.req.header("authorization"));
      return c.json(
        await prepareVaultTransfer(client, await readIndex(), owner, await c.req.json(), action),
      );
    });
}
