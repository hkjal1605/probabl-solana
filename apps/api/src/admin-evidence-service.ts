import type {
  AdminAction,
  AdminTransactionPreview,
  EvidenceAttachmentStore,
  EvidenceQueries,
  EvidenceReview,
} from "@conditional-stocks/db/evidence";
import { hashResolutionCommitment } from "@conditional-stocks/domain";
import {
  assertEvidenceIntegrity,
  buildCreationEvidence,
  buildResolutionEvidence,
  type CreationEvidencePacket,
  canonicalStringify,
  type EvidenceEnvelope,
  MarketDataError,
  type ResolutionEvidencePacket,
} from "@conditional-stocks/market-data";
import { type Address, getAddress, type Hex, isHex } from "viem";
import type { AdminEvidenceChain } from "./admin-chain.ts";
import type { AdminEvidenceEnvironment } from "./admin-environment.ts";
import type { CanonicalMarket, IndexerClient } from "./chain.ts";
import type { PolymarketIngestorClient } from "./polymarket-client.ts";

const CREATION_CHECKS = [
  "stock-and-quote",
  "condition-id",
  "yes-no-orientation",
  "rules-and-dates",
  "source-and-raw-hash",
] as const;
const RESOLUTION_CHECKS = [
  "frozen-or-awaiting",
  "condition-id",
  "yes-no-orientation",
  "final-status",
  "polygon-reference",
  "attachments",
  "payout-vector",
] as const;

const bodyObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MarketDataError("INVALID_REQUEST", "body must be an object");
  }
  return value as Record<string, unknown>;
};

const hex32 = (value: unknown, name: string): Hex => {
  if (typeof value !== "string" || !isHex(value, { strict: true }) || value.length !== 66) {
    throw new MarketDataError("INVALID_REQUEST", `${name} must be bytes32`);
  }
  return value.toLowerCase() as Hex;
};

const string = (value: unknown, name: string, maximum = 4_096): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new MarketDataError("INVALID_REQUEST", `${name} is required`);
  }
  return value;
};

const equalsAddress = (left: string, right: string): boolean =>
  getAddress(left) === getAddress(right);

export class AdminEvidenceService {
  constructor(
    readonly environment: AdminEvidenceEnvironment,
    readonly store: EvidenceQueries,
    readonly attachments: EvidenceAttachmentStore,
    readonly chain: Pick<
      AdminEvidenceChain,
      | "assertTransactionMatches"
      | "beginResolutionPreview"
      | "creationPreview"
      | "resolutionPreview"
    >,
    readonly indexer: Pick<IndexerClient, "market" | "resolution" | "transaction">,
    readonly polymarket: Pick<
      PolymarketIngestorClient,
      "fetchMetadata" | "metadata" | "probability" | "snapshot" | "track"
    >,
  ) {}

  async fetchPolymarketMetadata(input: unknown, session: Address) {
    this.#authorize(session);
    const body = bodyObject(input);
    return this.polymarket.fetchMetadata(string(body.gammaMarketId, "gammaMarketId", 256));
  }

  async prepareCreation(input: unknown, session: Address) {
    this.#authorize(session);
    const body = bodyObject(input);
    const snapshot = await this.polymarket.snapshot(
      string(body.metadataSnapshotId, "metadataSnapshotId", 256),
    );
    const stored = await this.store.preparePacket(
      body.attachments ?? [],
      this.attachments.publicBaseUrl,
      (attachmentReferences) =>
        buildCreationEvidence({
          attachments: attachmentReferences,
          config: body.config,
          metadata: snapshot.normalized,
          metadataRawHash: snapshot.rawHash,
          metadataSnapshotId: snapshot.snapshotId,
          preparedAt: new Date().toISOString(),
          preparer: session,
          sourceUrls: body.sourceUrls,
        }),
    );
    return await this.#view(stored);
  }

  async prepareResolution(input: unknown, session: Address) {
    this.#authorize(session);
    const body = bodyObject(input);
    const marketId = hex32(body.marketId, "marketId");
    const market = await this.indexer.market(marketId);
    if (!market) throw new MarketDataError("NOT_FOUND", "local market not found", 404);
    if (market.state !== 3 && market.state !== 4) {
      throw new MarketDataError(
        "INVALID_MARKET_STATE",
        "resolution evidence requires a frozen or awaiting-resolution market",
        409,
      );
    }
    const snapshot = await this.polymarket.snapshot(
      string(body.metadataSnapshotId, "metadataSnapshotId", 256),
    );
    this.#assertSnapshotMatchesMarket(snapshot.normalized, market);
    const stored = await this.store.preparePacket(
      body.attachments ?? [],
      this.attachments.publicBaseUrl,
      (references) =>
        buildResolutionEvidence({
          attachments: references,
          conditionId: market.conditionId,
          marketId,
          metadataRawHash: snapshot.rawHash,
          metadataSnapshotId: snapshot.snapshotId,
          officialStatus: body.officialStatus,
          officialUrl: body.officialUrl,
          payout: body.payout,
          polygon: body.polygon,
          polymarketConditionId: market.polymarketConditionId,
          polymarketNoIndex: String(market.polymarketNoIndex),
          polymarketYesIndex: String(market.polymarketYesIndex),
          preparedAt: new Date().toISOString(),
          preparer: session,
          sourceObservations: body.sourceObservations,
          sourceReference: body.sourceReference,
        }),
    );
    return await this.#view(stored);
  }

  async review(packetHashInput: string, input: unknown, session: Address) {
    this.#authorize(session);
    const packetHash = hex32(packetHashInput, "packetHash");
    const stored = await this.store.requiredPacket(packetHash);
    assertEvidenceIntegrity(stored.envelope);
    await this.attachments.verify(stored.envelope.packet.attachments);
    const body = bodyObject(input);
    if (body.decision !== "approve" && body.decision !== "reject") {
      throw new MarketDataError("INVALID_REQUEST", "decision must be approve or reject");
    }
    const checks = bodyObject(body.checklist);
    const requiredChecks =
      stored.envelope.packet.kind === "market-creation" ? CREATION_CHECKS : RESOLUTION_CHECKS;
    const checklist = Object.fromEntries(requiredChecks.map((key) => [key, checks[key] === true]));
    if (body.decision === "approve" && Object.values(checklist).some((value) => !value)) {
      throw new MarketDataError(
        "INCOMPLETE_REVIEW",
        "every market-admin review checklist item must be true",
        409,
      );
    }
    const review: EvidenceReview = {
      checklist,
      decision: body.decision,
      notes: typeof body.notes === "string" ? body.notes.slice(0, 4_096) : "",
      packetHash,
      reviewId: crypto.randomUUID(),
      reviewedAt: new Date().toISOString(),
      reviewer: session,
    };
    await this.store.appendReview(review);
    return await this.#view(stored);
  }

  async transaction(packetHashInput: string, session: Address) {
    this.#authorize(session);
    const packetHash = hex32(packetHashInput, "packetHash");
    const stored = await this.store.requiredPacket(packetHash);
    if ((await this.store.status(packetHash)) !== "approved") {
      throw new MarketDataError(
        "REVIEW_REQUIRED",
        "packet requires explicit market-admin approval",
        409,
      );
    }
    assertEvidenceIntegrity(stored.envelope);
    await this.attachments.verify(stored.envelope.packet.attachments);
    let preview: AdminTransactionPreview;
    if (stored.envelope.packet.kind === "market-creation") {
      preview = await this.chain.creationPreview(
        stored.envelope as EvidenceEnvelope<CreationEvidencePacket>,
      );
    } else {
      const envelope = stored.envelope as EvidenceEnvelope<ResolutionEvidencePacket>;
      const market = await this.indexer.market(envelope.packet.localMarket.marketId);
      if (!market) throw new MarketDataError("NOT_FOUND", "local market not found", 404);
      preview =
        market.state === 3
          ? await this.chain.beginResolutionPreview(envelope)
          : market.state === 4
            ? await this.chain.resolutionPreview(envelope)
            : (() => {
                throw new MarketDataError(
                  "INVALID_MARKET_STATE",
                  "market must be frozen or awaiting resolution",
                  409,
                );
              })();
    }
    await this.store.appendPreview(preview);
    await this.store.audit("TRANSACTION_SIMULATED", session, packetHash, {
      action: preview.action,
      previewId: preview.previewId,
    });
    return preview;
  }

  async verifyTransaction(packetHashInput: string, input: unknown, session: Address) {
    this.#authorize(session);
    const packetHash = hex32(packetHashInput, "packetHash");
    const body = bodyObject(input);
    const action = string(body.action, "action", 32) as AdminAction;
    const preview = [...(await this.store.previews(packetHash))]
      .reverse()
      .find((item) => item.action === action);
    if (!preview) throw new MarketDataError("NOT_FOUND", "transaction preview not found", 404);
    const proposed = {
      action,
      chainId: body.chainId,
      data: body.data,
      from: body.from,
      to: body.to,
      value: body.value,
    };
    const expected = {
      action: preview.action,
      chainId: preview.chainId,
      data: preview.data,
      from: preview.from,
      to: preview.to,
      value: preview.value,
    };
    if (canonicalStringify(proposed) !== canonicalStringify(expected)) {
      throw new MarketDataError(
        "TRANSACTION_MISMATCH",
        "proposed multisig transaction does not match the reviewed preview",
        409,
      );
    }
    await this.store.audit("TRANSACTION_VERIFIED", session, packetHash, { action });
    return { matches: true, previewId: preview.previewId };
  }

  async reconcile(packetHashInput: string, input: unknown, session: Address) {
    this.#authorize(session);
    const packetHash = hex32(packetHashInput, "packetHash");
    const body = bodyObject(input);
    const transactionHash = hex32(body.transactionHash, "transactionHash");
    const action = string(body.action, "action", 32) as AdminAction;
    const stored = await this.store.requiredPacket(packetHash);
    const preview = (await this.store.previews(packetHash)).find(
      (candidate) => candidate.action === action,
    );
    if (!preview)
      throw new MarketDataError("NOT_FOUND", "approved transaction preview not found", 404);
    const transaction = await this.indexer.transaction(transactionHash);
    if (transaction?.status !== "success") {
      throw new MarketDataError(
        "CANONICAL_TRANSACTION_REQUIRED",
        "successful indexed transaction is required",
        409,
      );
    }
    try {
      await this.chain.assertTransactionMatches(preview, transactionHash);
    } catch (error) {
      throw new MarketDataError(
        "TRANSACTION_MISMATCH",
        error instanceof Error ? error.message : "canonical transaction does not match preview",
        409,
      );
    }
    let canonical: unknown;
    if (action === "create-market" && stored.envelope.packet.kind === "market-creation") {
      const market = await this.indexer.market(preview.expectedMarketId);
      if (!market) throw new MarketDataError("NOT_FOUND", "created market is not indexed", 404);
      this.#assertCreatedMarket(stored.envelope.packet, market);
      canonical = market;
      await this.polymarket.track(stored.envelope.packet.polymarket.metadataSnapshotId);
    } else if (
      action === "begin-resolution" &&
      stored.envelope.packet.kind === "market-resolution"
    ) {
      const market = await this.indexer.market(stored.envelope.packet.localMarket.marketId);
      const packet = stored.envelope.packet;
      const commitment = hashResolutionCommitment({
        chainId: BigInt(preview.chainId),
        controller: this.environment.resolutionController,
        marketId: packet.localMarket.marketId,
        yesPayout: BigInt(packet.payout.yes),
        noPayout: BigInt(packet.payout.no),
        payoutDenominator: BigInt(packet.payout.denominator),
        evidenceHash: packetHash,
        evidenceUri: packet.sourceReference,
      });
      if (market?.state !== 4 || market.stateReasonHash !== commitment) {
        throw new MarketDataError(
          "CANONICAL_MISMATCH",
          "awaiting-resolution state does not anchor the exact resolution commitment",
          409,
        );
      }
      canonical = market;
    } else if (action === "resolve-market" && stored.envelope.packet.kind === "market-resolution") {
      const resolution = await this.indexer.resolution(stored.envelope.packet.localMarket.marketId);
      if (
        !resolution ||
        resolution.evidenceHash !== packetHash ||
        resolution.evidenceUri !== stored.envelope.packet.sourceReference ||
        resolution.yesPayout !== stored.envelope.packet.payout.yes ||
        resolution.noPayout !== stored.envelope.packet.payout.no ||
        resolution.payoutDenominator !== stored.envelope.packet.payout.denominator
      ) {
        throw new MarketDataError(
          "CANONICAL_MISMATCH",
          "ResolutionFinalized does not match the approved evidence packet",
          409,
        );
      }
      canonical = resolution;
    } else {
      throw new MarketDataError("ACTION_MISMATCH", "action does not match packet kind", 409);
    }
    const observation = await this.store.appendObservation({
      action,
      canonical,
      observationId: crypto.randomUUID(),
      observedAt: new Date().toISOString(),
      packetHash,
      transactionHash,
    });
    await this.store.audit("TRANSACTION_RECONCILED", session, packetHash, {
      action,
      transactionHash,
    });
    return observation;
  }

  async packet(packetHashInput: string, session: Address) {
    this.#authorize(session);
    return await this.#view(await this.store.requiredPacket(hex32(packetHashInput, "packetHash")));
  }

  async packets(session: Address) {
    this.#authorize(session);
    return { packets: await this.store.packetViews() };
  }

  async history(session: Address) {
    this.#authorize(session);
    return { actions: await this.store.auditHistory() };
  }

  async marketData(marketIdInput: string) {
    const marketId = hex32(marketIdInput, "marketId");
    const market = await this.indexer.market(marketId);
    if (!market) throw new MarketDataError("NOT_FOUND", "local market not found", 404);
    const [metadata, probability] = await Promise.all([
      this.polymarket.metadata(market.polymarketConditionId),
      this.polymarket.probability(market.polymarketConditionId).catch(() => null),
    ]);
    this.#assertSnapshotMatchesMarket(metadata.normalized, market);
    return {
      informationalOnly: true,
      localMarketId: marketId,
      metadata,
      probability,
      settlementAuthority: "manual-admin-only",
    };
  }

  async marketProbability(marketIdInput: string) {
    const marketId = hex32(marketIdInput, "marketId");
    const market = await this.indexer.market(marketId);
    if (!market) throw new MarketDataError("NOT_FOUND", "local market not found", 404);
    return {
      informationalOnly: true,
      localMarketId: marketId,
      probability: await this.polymarket.probability(market.polymarketConditionId),
      settlementAuthority: "manual-admin-only",
    };
  }

  async publicResolutionEvidence(marketIdInput: string) {
    const marketId = hex32(marketIdInput, "marketId");
    const packet = await this.store.latestApprovedPacketForMarket(marketId);
    if (!packet) throw new MarketDataError("NOT_FOUND", "approved evidence not found", 404);
    return await this.#view(packet);
  }

  async publicAttachment(input: string): Promise<Uint8Array> {
    const contentHash = hex32(input.startsWith("0x") ? input : `0x${input}`, "contentHash");
    const content = await this.store.publishedAttachment(contentHash);
    if (!content) throw new MarketDataError("NOT_FOUND", "published attachment not found", 404);
    return new Uint8Array(content);
  }

  async #view(stored: Awaited<ReturnType<EvidenceQueries["requiredPacket"]>>) {
    return await this.store.packetView(stored);
  }

  #authorize(session: Address): void {
    if (!equalsAddress(session, this.environment.marketAdmin)) {
      throw new MarketDataError("ADMIN_FORBIDDEN", "MARKET_ADMIN session required", 403);
    }
  }

  #assertSnapshotMatchesMarket(
    metadata: Awaited<ReturnType<PolymarketIngestorClient["snapshot"]>>["normalized"],
    market: CanonicalMarket,
  ): void {
    const yes = metadata.outcomes.find((outcome) => outcome.label === "YES");
    const no = metadata.outcomes.find((outcome) => outcome.label === "NO");
    if (
      metadata.conditionId !== market.polymarketConditionId.toLowerCase() ||
      !yes ||
      !no ||
      yes.indexSet !== String(market.polymarketYesIndex) ||
      no.indexSet !== String(market.polymarketNoIndex)
    ) {
      throw new MarketDataError(
        "MAPPING_MISMATCH",
        "Polymarket snapshot does not match immutable local market orientation",
        409,
      );
    }
  }

  #assertCreatedMarket(packet: CreationEvidencePacket, market: CanonicalMarket): void {
    const config = packet.config;
    const matches =
      equalsAddress(market.baseToken, config.baseToken) &&
      equalsAddress(market.quoteToken, config.quoteToken) &&
      market.polymarketConditionId.toLowerCase() === config.polymarketConditionId &&
      String(market.polymarketYesIndex) === config.polymarketYesIndex &&
      String(market.polymarketNoIndex) === config.polymarketNoIndex &&
      market.rulesHash === config.rulesHash &&
      market.metadataHash === config.metadataHash &&
      String(market.tradingOpen) === config.tradingOpen &&
      String(market.tradingCutoff) === config.tradingCutoff &&
      String(market.priceTickRawX18) === config.priceTickRawX18 &&
      String(market.baseStep) === config.baseStep &&
      String(market.minNotional) === config.minNotional &&
      String(market.maxOrderQuantity) === config.maxOrderQuantity &&
      String(market.maxOrderNotional) === config.maxOrderNotional &&
      String(market.maxWalletOpenNotional) === config.maxWalletOpenNotional &&
      String(market.maxMarketOpenNotional) === config.maxMarketOpenNotional;
    if (!matches) {
      throw new MarketDataError(
        "CANONICAL_MISMATCH",
        "created onchain market does not match approved evidence",
        409,
      );
    }
  }
}

export const creationReviewChecklist = CREATION_CHECKS;
export const resolutionReviewChecklist = RESOLUTION_CHECKS;
