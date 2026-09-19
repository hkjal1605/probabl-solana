import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { createSolanaDatabase } from "@conditional-stocks/db/solana";
import { hashCanonical, normalizeGammaMarket } from "@conditional-stocks/market-data";
import { digest, key, SolanaClient } from "@conditional-stocks/solana-client";
import {
  type AdminTransaction,
  initializeMarketVaults,
} from "@conditional-stocks/solana-client/admin";
import { Keypair } from "@solana/web3.js";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { gammaMarket } from "../../../../packages/market-data/tests/helpers.ts";
import { mountSolanaAdmin } from "../../src/solana/admin/routes.ts";

test.skipIf(process.env.SOLANA_APP_E2E !== "1")(
  "governance evidence review → native creation → vault setup → freeze → commitment → resolution → finalized reconciliation",
  async () => {
    if (!process.env.TEST_DATABASE_URL)
      throw new Error("An isolated TEST_DATABASE_URL is required");
    const deployment = await Bun.file(
        resolve(process.env.SOLANA_FIXTURE_DIR ?? ".local", "deployment.json"),
      ).json(),
      client = new SolanaClient(deployment),
      admin = Keypair.fromSecretKey(
        Uint8Array.from(
          await Bun.file(resolve(process.env.SOLANA_FIXTURE_DIR ?? ".local", "admin.json")).json(),
        ),
      );
    const db = createSolanaDatabase({ connectionString: process.env.TEST_DATABASE_URL }),
      app = new Hono(),
      domain = "admin-test:" + crypto.randomUUID();
    const raw = gammaMarket({ closed: true, umaResolutionStatus: "resolved" }),
      source = {
        normalized: normalizeGammaMarket(raw),
        rawHash: hashCanonical(raw),
        rawPayload: raw,
        snapshotId: "test",
        fetchedAtMs: String(Date.now()),
      };
    const mock = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(source) });
    const previous = {
      url: process.env.POLYMARKET_INGESTOR_URL,
      token: process.env.POLYMARKET_INTERNAL_TOKEN,
    };
    process.env.POLYMARKET_INGESTOR_URL = mock.url.toString().replace(/\/$/, "");
    process.env.POLYMARKET_INTERNAL_TOKEN = "test-ingestor-credential";
    app.onError((e) =>
      Response.json({ error: e.message }, { status: e instanceof HTTPException ? e.status : 400 }),
    );
    await mountSolanaAdmin(app, db, client, domain, async (header) => {
      if (!header?.startsWith("Bearer ")) throw new HTTPException(401);
      return header.slice(7);
    });
    const post = async (path: string, body: unknown, owner = admin.publicKey.toBase58()) => {
      const response = await app.request("http://api.test/v1/" + path, {
        method: "POST",
        headers: { authorization: "Bearer " + owner, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(value));
      return value;
    };
    const send = async (transaction: AdminTransaction) => {
      const built = await client.prepareTransaction(admin.publicKey, transaction);
      built.transaction.sign([admin]);
      const signature = await client.connection.sendRawTransaction(built.transaction.serialize(), {
        skipPreflight: false,
      });
      const result = await client.connection.confirmTransaction(
        { signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight },
        "confirmed",
      );
      expect(result.value.err).toBeNull();
      return signature;
    };
    try {
      await expect(
        post("admin/polymarket/metadata/fetch", { gammaMarketId: "test" }, deployment.bob),
      ).rejects.toThrow("role");
      const now = Math.floor(Date.now() / 1000),
        config = {
          baseToken: deployment.baseMint,
          quoteToken: deployment.quoteMint,
          baseStep: "1000",
          priceTickRawX18: "10000000000000000",
          minNotional: "1",
          maxOrderQuantity: "1000000000",
          maxOrderNotional: "10000000000",
          maxWalletOpenNotional: "20000000000",
          maxMarketOpenNotional: "40000000000",
          metadataUri: "ipfs://governance-test-" + crypto.randomUUID(),
          rules: "Controlled local test only",
          tradingOpen: String(now - 1),
          tradingCutoff: String(now + 3600),
        };
      const created = await post("admin/evidence/creation/prepare", {
          config,
          attachments: [],
          metadataSnapshotId: "test",
          sourceUrls: [source.normalized.canonicalUrl],
        }),
        hash = created.envelope.packetHash;
      await expect(post("admin/evidence/" + hash + "/transaction", {})).rejects.toThrow("approval");
      await expect(
        post("admin/evidence/" + hash + "/review", { decision: "approve", checklist: {} }),
      ).rejects.toThrow("checklist");
      const checklist = Object.fromEntries(
        [
          "stock-and-quote",
          "condition-id",
          "yes-no-orientation",
          "rules-and-dates",
          "source-and-raw-hash",
        ].map((k) => [k, true]),
      );
      expect(
        (await post("admin/evidence/" + hash + "/review", { decision: "approve", checklist }))
          .status,
      ).toBe("approved");
      await expect(
        post("admin/evidence/" + hash + "/review", { decision: "reject" }),
      ).rejects.toThrow("immutable review");
      const preview = await post("admin/evidence/" + hash + "/transaction", {});
      expect(preview.action).toBe("create-market");
      const creationSignature = await send(preview),
        market = key(preview.expectedMarketId);
      for (const transaction of await initializeMarketVaults(
        client,
        market.toBase58(),
        admin.publicKey.toBase58(),
      ))
        await send(transaction);
      const lifecycle = async (action: number) => {
        const { envelope } = await import("@conditional-stocks/solana-client");
        await send({
          ...envelope([
            client.ix(
              "lifecycle",
              { action, commitment: [...digest("test governance")] },
              { actor: admin.publicKey, config: client.config, market },
            ),
          ]),
          from: admin.publicKey.toBase58(),
          chainId: 1,
        });
      };
      await lifecycle(0);
      await lifecycle(1);
      const payout = { yes: "1", no: "1", denominator: "2" },
        url = source.normalized.canonicalUrl;
      const resolutionInput = {
        marketId: market.toBase58(),
        metadataSnapshotId: "test",
        officialStatus: "resolved",
        officialUrl: url,
        payout,
        polygon: {
          chainId: "137",
          conditionalTokensAddress: "0x1000000000000000000000000000000000000001",
        },
        attachments: [],
        sourceObservations: [
          { observedAt: new Date().toISOString(), payout, status: "resolved", url },
        ],
        sourceReference: "ipfs://resolution-" + crypto.randomUUID(),
      };
      const resolution = await post("admin/evidence/resolution/prepare", resolutionInput),
        resolutionHash = resolution.envelope.packetHash;
      const conflict = {
        ...resolutionInput,
        payout: { yes: "1", no: "0", denominator: "1" },
        sourceObservations: [
          {
            ...resolutionInput.sourceObservations[0],
            payout: { yes: "1", no: "0", denominator: "1" },
          },
        ],
      };
      await expect(post("admin/evidence/resolution/prepare", conflict)).rejects.toThrow(
        "conflicting payout",
      );
      await post("admin/evidence/" + resolutionHash + "/review", {
        decision: "approve",
        checklist: Object.fromEntries(
          [
            "frozen-or-awaiting",
            "condition-id",
            "yes-no-orientation",
            "final-status",
            "polygon-reference",
            "attachments",
            "payout-vector",
          ].map((k) => [k, true]),
        ),
      });
      const begin = await post("admin/evidence/" + resolutionHash + "/transaction", {});
      expect(begin.action).toBe("begin-resolution");
      await send(begin);
      const resolve = await post("admin/evidence/" + resolutionHash + "/transaction", {});
      expect(resolve.action).toBe("resolve-market");
      const signature = await send(resolve);
      expect((await client.market(market)).payouts).toEqual([1, 1]);
      await expect(
        post("admin/evidence/" + resolutionHash + "/reconcile", {
          action: "resolve-market",
          transactionHash: creationSignature,
        }),
      ).rejects.toThrow();
      const deadline = Date.now() + 45_000;
      let observed: any;
      while (Date.now() < deadline) {
        try {
          observed = await post("admin/evidence/" + resolutionHash + "/reconcile", {
            action: "resolve-market",
            transactionHash: signature,
          });
          break;
        } catch (e) {
          if (!String(e).includes("finalized")) throw e;
          await Bun.sleep(500);
        }
      }
      expect(observed?.transactionHash).toBe(signature);
    } finally {
      await db.close();
      await mock.stop(true);
      if (previous.url === undefined) delete process.env.POLYMARKET_INGESTOR_URL;
      else process.env.POLYMARKET_INGESTOR_URL = previous.url;
      if (previous.token === undefined) delete process.env.POLYMARKET_INTERNAL_TOKEN;
      else process.env.POLYMARKET_INTERNAL_TOKEN = previous.token;
    }
  },
  120_000,
);
