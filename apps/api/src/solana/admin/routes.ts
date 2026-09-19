import type { SolanaDatabase, SolanaQueries } from "@conditional-stocks/db/solana";
import {
  canonicalStringify,
  noOutcome,
  requiredString,
  yesOutcome,
} from "@conditional-stocks/market-data";
import { ReadCache } from "@conditional-stocks/shared/read-cache";
import { RedisCache } from "@conditional-stocks/shared/redis-cache";
import {
  address,
  bytes32,
  hex,
  key,
  type SolanaClient,
  unwrap,
} from "@conditional-stocks/solana-client";
import {
  type AdminDeployment,
  type AdminPreview,
  evidenceTransaction,
  type PacketEnvelope,
  preflightAdmin,
} from "@conditional-stocks/solana-client/admin";
import {
  type AttachmentReference,
  assertAttachmentIntegrity,
  assertEvidenceIntegrity,
  attachmentContentHash,
  buildCreationEvidence,
  buildResolutionEvidence,
} from "@conditional-stocks/solana-client/evidence";
import bs58 from "bs58";
import { Buffer } from "buffer";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "../../common/logger.ts";
import { PolymarketIngestorClient } from "../../integrations/polymarket/client.ts";
import { CachedProbability, mountProbabilityStream } from "../market-data/probability-stream.ts";

const creationChecks = [
  "stock-and-quote",
  "condition-id",
  "yes-no-orientation",
  "rules-and-dates",
  "source-and-raw-hash",
];
const resolutionChecks = [
  "frozen-or-awaiting",
  "condition-id",
  "yes-no-orientation",
  "final-status",
  "polygon-reference",
  "attachments",
  "payout-vector",
];
type View = {
  envelope: PacketEnvelope;
  status: "prepared" | "approved" | "rejected";
  reviews: any[];
  previews: AdminPreview[];
  observations: any[];
};
const invalid = (message: string, status: 400 | 403 | 404 | 409 | 503 = 400) =>
  new HTTPException(status, { message });

export async function mountSolanaAdmin(
  app: Hono,
  db: SolanaDatabase,
  client: SolanaClient,
  domain: string,
  authenticate: (header: string | undefined) => Promise<string>,
) {
  // Only informational public reads share this cache; all governance actions stay live.
  const publicReads = new ReadCache(3000);
  const publicMarket = (id: string) => {
    const market = key(address(id));
    return publicReads.get(market.toBase58(), () => client.market(market));
  };
  const deployment = async (): Promise<AdminDeployment> => {
    const cfg = await client.configAccount();
    return {
      ...client.deployment,
      programId: client.program.toBase58(),
      marketAdmin: cfg.roles.market_admin.toBase58(),
      resolutionAdmin: cfg.roles.resolution_admin.toBase58(),
    };
  };
  const operator = async (header: string | undefined, reviewOnly = false) => {
    const owner = await authenticate(header),
      d = await deployment();
    if (owner !== d.marketAdmin && (reviewOnly || owner !== d.resolutionAdmin))
      throw invalid("Required governance role is not assigned to this wallet", 403);
    return owner;
  };
  const polymarket = () => {
    const url = process.env.POLYMARKET_INGESTOR_URL,
      token = process.env.POLYMARKET_INTERNAL_TOKEN;
    if (!url || !token) throw invalid("Polymarket ingestor is not configured", 503);
    return new PolymarketIngestorClient(url, token);
  };
  let lastCacheWarning = 0;
  const probabilityCache = new RedisCache(
    process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
    `probabl:probability:v1:${domain}`,
    () => {
      if (Date.now() - lastCacheWarning > 30_000) {
        lastCacheWarning = Date.now();
        logger.warn("probability.cache.unavailable");
      }
    },
  );
  const probabilities = new CachedProbability(probabilityCache, (condition) =>
    polymarket().probability(condition),
  );
  mountProbabilityStream(app, probabilities);
  const read = async (hash: string, query: SolanaQueries = db): Promise<View> => {
    bytes32(hash);
    const envelope = (await query.evidence(domain, hash)) as PacketEnvelope | undefined;
    if (!envelope) throw invalid("Evidence packet not found", 404);
    assertEvidenceIntegrity(envelope);
    const actions = await query.evidenceActions(domain, hash);
    const select = (kind: string) => actions.filter((r) => r.kind === kind).map((r) => r.payload),
      reviews = select("REVIEW");
    return {
      envelope,
      status:
        reviews.at(-1)?.decision === "approve"
          ? "approved"
          : reviews.at(-1)?.decision === "reject"
            ? "rejected"
            : "prepared",
      reviews,
      previews: select("PREVIEW"),
      observations: select("RECONCILE"),
    };
  };
  const locked = <T>(work: (tx: SolanaQueries) => Promise<T>) =>
    db.locked("evidence:" + domain, work);
  const audit = async (
    tx: SolanaQueries,
    hash: string,
    kind: string,
    actor: string,
    payload: unknown,
  ) => {
    await tx.audit(domain, hash, kind, actor, payload);
  };
  const attachments = async (input: unknown, tx: SolanaQueries) => {
    if (!Array.isArray(input) || input.length > 32)
      throw invalid("At most 32 attachments are allowed");
    const references: AttachmentReference[] = [];
    let total = 0;
    for (const value of input) {
      const filename = requiredString(value.filename, "filename", 256),
        mediaType = requiredString(value.mediaType, "mediaType", 128),
        encoded = requiredString(value.contentBase64, "contentBase64", 14_000_000);
      const content = Buffer.from(encoded, "base64");
      total += content.length;
      if (
        !content.length ||
        content.length > 10 * 1024 * 1024 ||
        total > 25 * 1024 * 1024 ||
        content.toString("base64") !== encoded
      )
        throw invalid("Attachment size or base64 is invalid");
      const contentHash = attachmentContentHash(content);
      if (value.contentHash !== undefined && value.contentHash !== contentHash)
        throw invalid("Declared attachment hash differs", 409);
      const base = process.env.EVIDENCE_PUBLIC_BASE_URL;
      if (!base || new URL(base).protocol !== "https:")
        throw invalid("A public HTTPS evidence attachment URL must be configured", 503);
      const reference = {
        filename,
        mediaType,
        contentHash,
        byteLength: String(content.length),
        uri: base.replace(/\/$/, "") + "/" + contentHash.slice(2),
      };
      await tx.putAttachment(domain, contentHash, content);
      references.push(reference);
    }
    return references;
  };
  const verifyAttachments = async (view: View, query: SolanaQueries = db) => {
    for (const reference of view.envelope.packet.attachments) {
      const content = await query.attachment(domain, reference.contentHash);
      if (!content) throw invalid("Evidence attachment is missing", 409);
      assertAttachmentIntegrity(reference, content);
    }
  };
  const assertMapping = (
    metadata: Awaited<ReturnType<PolymarketIngestorClient["snapshot"]>>["normalized"],
    m: Awaited<ReturnType<SolanaClient["market"]>>,
  ) => {
    if (
      metadata.conditionId !== hex(m.terms.condition) ||
      yesOutcome(metadata).indexSet !== String(m.terms.yes_index) ||
      noOutcome(metadata).indexSet !== String(m.terms.no_index)
    )
      throw invalid("External snapshot does not match immutable market orientation", 409);
  };

  app.post("/v1/admin/polymarket/metadata/fetch", async (c) => {
    await operator(c.req.header("authorization"));
    const body = await c.req.json();
    return c.json(
      await polymarket().fetchMetadata(requiredString(body.gammaMarketId, "gammaMarketId", 256)),
    );
  });
  for (const kind of ["creation", "resolution"] as const)
    app.post(`/v1/admin/evidence/${kind}/prepare`, async (c) => {
      const owner = await operator(c.req.header("authorization"), true),
        body = await c.req.json(),
        d = await deployment();
      const source = await polymarket().snapshot(
        requiredString(body.metadataSnapshotId, "metadataSnapshotId", 256),
      );
      const market =
        kind === "resolution" ? await client.market(key(address(body.marketId))) : null;
      if (market) {
        if (![3, 4].includes(market.state))
          throw invalid("Resolution requires a frozen or awaiting market", 409);
        assertMapping(source.normalized, market);
      }
      const hash = await locked(async (tx) => {
        const references = await attachments(body.attachments ?? [], tx),
          shared = {
            deployment: d,
            attachments: references,
            preparedAt: new Date().toISOString(),
            preparer: owner,
            metadataRawHash: source.rawHash,
            metadataSnapshotId: source.snapshotId,
          };
        const value: PacketEnvelope =
          kind === "creation"
            ? buildCreationEvidence({
                ...shared,
                config: body.config,
                metadata: source.normalized,
                sourceUrls: body.sourceUrls,
              })
            : buildResolutionEvidence({
                ...shared,
                conditionId: body.marketId,
                marketId: body.marketId,
                officialStatus: body.officialStatus,
                officialUrl: body.officialUrl,
                payout: body.payout,
                polygon: body.polygon,
                polymarketConditionId: hex(market!.terms.condition),
                polymarketYesIndex: String(market!.terms.yes_index),
                polymarketNoIndex: String(market!.terms.no_index),
                sourceObservations: body.sourceObservations,
                sourceReference: body.sourceReference,
              });
        assertEvidenceIntegrity(value);
        if (value.packet.kind === "market-resolution") {
          const existing = await tx.evidenceForMarket(domain, body.marketId);
          for (const row of existing) {
            const prior = await read(row.hash, tx);
            if (
              prior.status !== "rejected" &&
              prior.envelope.packet.kind === "market-resolution" &&
              canonicalStringify(prior.envelope.packet.payout) !==
                canonicalStringify(value.packet.payout)
            )
              throw invalid("An active evidence packet declares a conflicting payout", 409);
          }
        }
        await tx.putEvidence(domain, value.packetHash, value);
        await audit(tx, value.packetHash, "PREPARE", owner, { kind: value.packet.kind });
        return value.packetHash;
      });
      return c.json(await read(hash));
    });
  app.get("/v1/admin/evidence", async (c) => {
    await operator(c.req.header("authorization"));
    const rows = await db.evidenceList(domain);
    return c.json({ packets: await Promise.all(rows.map((r) => read(r.hash))) });
  });
  app.get("/v1/admin/evidence/:hash", async (c) => {
    await operator(c.req.header("authorization"));
    return c.json(await read(c.req.param("hash")));
  });
  app.post("/v1/admin/evidence/:hash/review", async (c) => {
    const owner = await operator(c.req.header("authorization"), true),
      hash = c.req.param("hash"),
      body = await c.req.json();
    await locked(async (tx) => {
      const view = await read(hash, tx);
      if (view.status !== "prepared") throw invalid("An immutable review already exists", 409);
      if (body.decision !== "approve" && body.decision !== "reject")
        throw invalid("Review decision is invalid");
      const checks =
        view.envelope.packet.kind === "market-creation" ? creationChecks : resolutionChecks;
      if (body.decision === "approve" && checks.some((k) => body.checklist?.[k] !== true))
        throw invalid("Every review checklist item must be confirmed", 409);
      await verifyAttachments(view, tx);
      await audit(tx, hash, "REVIEW", owner, {
        decision: body.decision,
        reviewer: owner,
        reviewedAt: new Date().toISOString(),
        checklist: Object.fromEntries(checks.map((k) => [k, body.checklist?.[k] === true])),
        notes: typeof body.notes === "string" ? body.notes.slice(0, 4096) : "",
      });
    });
    return c.json(await read(hash));
  });
  app.post("/v1/admin/evidence/:hash/transaction", async (c) => {
    const owner = await operator(c.req.header("authorization")),
      hash = c.req.param("hash"),
      view = await read(hash);
    if (view.status !== "approved") throw invalid("Explicit approval is required", 409);
    await verifyAttachments(view);
    const p = view.envelope.packet,
      m = p.kind === "market-resolution" ? await client.market(key(p.localMarket.marketId)) : null;
    if (m && ![3, 4].includes(m.state))
      throw invalid("Market is no longer frozen or awaiting resolution", 409);
    const action =
      p.kind === "market-creation"
        ? "create-market"
        : m!.state === 3
          ? "begin-resolution"
          : "resolve-market";
    const preview: AdminPreview = {
      ...evidenceTransaction(view.envelope, action, await deployment()),
      action,
      packetHash: hash,
      previewId: crypto.randomUUID(),
    };
    await preflightAdmin(client, preview);
    await audit(db, hash, "PREVIEW", owner, preview);
    return c.json(preview);
  });
  app.post("/v1/admin/evidence/:hash/verify-transaction", async (c) => {
    await operator(c.req.header("authorization"));
    const view = await read(c.req.param("hash")),
      body = await c.req.json(),
      preview = view.previews.findLast((p) => p.action === body.action);
    if (!preview || view.status !== "approved") throw invalid("Approved preview not found", 409);
    for (const field of ["chainId", "from", "to", "data", "value"] as const)
      if (body[field] !== preview[field])
        throw invalid("Transaction differs from the approved preview", 409);
    return c.json({ matches: true, previewId: preview.previewId });
  });
  app.post("/v1/admin/evidence/:hash/reconcile", async (c) => {
    const owner = await operator(c.req.header("authorization")),
      hash = c.req.param("hash"),
      view = await read(hash),
      body = await c.req.json();
    const signature = requiredString(body.transactionHash, "transactionHash", 128);
    if (bs58.decode(signature).length !== 64) throw invalid("Invalid Solana signature");
    const preview = view.previews.findLast((p) => p.action === body.action);
    if (!preview || view.status !== "approved") throw invalid("Approved preview not found", 409);
    const result = await client.connection.getTransaction(signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    if (!result?.meta || result.meta.err)
      throw invalid("Successful finalized transaction is required", 409);
    const expected = unwrap(preview, client.program),
      message = result.transaction.message,
      keys = message.getAccountKeys({
        accountKeysFromLookups: result.meta.loadedAddresses ?? null,
      });
    const actual = message.compiledInstructions.filter((ix) =>
      keys.get(ix.programIdIndex)?.equals(client.program),
    );
    if (
      actual.length !== expected.length ||
      actual.some(
        (ix, i) =>
          !Buffer.from(ix.data).equals(expected[i]!.data) ||
          ix.accountKeyIndexes.length !== expected[i]!.keys.length ||
          ix.accountKeyIndexes.some(
            (index, j) =>
              !keys.get(index)?.equals(expected[i]!.keys[j]!.pubkey) ||
              (expected[i]!.keys[j]!.isSigner && !message.isAccountSigner(index)),
          ),
      )
    )
      throw invalid("Finalized instruction differs from the approved transaction", 409);
    // Exact executed instructions prove immutable terms; finalized state verifies the resulting PDA.
    const market = await client.fetch<any>("Market", key(preview.expectedMarketId));
    if (!market.config.equals(client.config))
      throw invalid("Market belongs to another deployment", 409);
    const observation = {
      action: preview.action,
      transactionHash: signature,
      observedAt: new Date().toISOString(),
      slot: String(result.slot),
    };
    await audit(db, hash, "RECONCILE", owner, observation);
    if (view.envelope.packet.kind === "market-creation")
      await polymarket().track(view.envelope.packet.polymarket.metadataSnapshotId);
    return c.json(observation);
  });
  app.get("/v1/admin/history", async (c) => {
    await operator(c.req.header("authorization"));
    const rows = await db.auditHistory(domain);
    return c.json({
      actions: rows.map((r) => ({
        id: r.id,
        action: r.kind,
        actor: r.actor,
        packetHash: r.packet_hash,
        details: r.payload,
        createdAt: r.created_at,
      })),
    });
  });
  app.get("/v1/markets/:id/polymarket", async (c) => {
    const m = await publicMarket(c.req.param("id")),
      source = polymarket(),
      metadata = await source.metadata(hex(m.terms.condition));
    assertMapping(metadata.normalized, m);
    return c.json({
      informationalOnly: true,
      localMarketId: c.req.param("id"),
      metadata,
      probability: await probabilities.get(hex(m.terms.condition)).catch(() => null),
      settlementAuthority: "manual-admin-only",
    });
  });
  app.get("/v1/markets/:id/probability", async (c) => {
    const m = await publicMarket(c.req.param("id"));
    return c.json({
      informationalOnly: true,
      probability: await probabilities.get(hex(m.terms.condition)),
      settlementAuthority: "manual-admin-only",
    });
  });
  app.get("/v1/markets/:id/resolution-evidence", async (c) => {
    const m = await client.market(key(address(c.req.param("id"))));
    if (![6, 7].includes(m.state)) throw invalid("Final evidence is not available", 404);
    return c.json(await read(hex(m.evidence)));
  });
  app.get("/v1/attachments/:hash", async (c) => {
    const hash = "0x" + c.req.param("hash").replace(/^0x/, "");
    bytes32(hash);
    const candidates = await db.attachmentEvidence(domain, hash);
    let published = false;
    for (const row of candidates)
      if ((await read(row.hash)).status === "approved") published = true;
    if (!published) throw invalid("Published attachment not found", 404);
    const content = await db.attachment(domain, hash);
    if (!content || attachmentContentHash(content) !== hash)
      throw invalid("Attachment integrity failure", 409);
    return new Response(new Uint8Array(content), {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": "attachment",
        "x-content-type-options": "nosniff",
      },
    });
  });
  return () => probabilityCache.close();
}
