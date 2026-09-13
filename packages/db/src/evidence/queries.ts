import {
  assertAttachmentIntegrity,
  assertEvidenceIntegrity,
  attachmentContentHash,
  canonicalStringify,
  type EvidenceEnvelope,
  MarketDataError,
  type ResolutionEvidencePacket,
} from "@conditional-stocks/market-data";
import { and, asc, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { Address, Hex } from "viem";
import { type ApplicationDatabase, boundedLimit } from "../connection.ts";
import {
  evidenceActions as actions,
  evidenceAttachmentLinks as attachmentLinks,
  evidenceAttachments as attachments,
  evidenceObservations as observationRows,
  evidencePackets as packetRows,
  evidencePreviews as previewRows,
  evidenceReviews as reviewRows,
} from "../schema.ts";
import type {
  AdminAuditRecord,
  AdminTransactionObservation,
  AdminTransactionPreview,
  EvidencePacket,
  EvidenceReview,
  EvidenceStatus,
  StoredEvidencePacket,
} from "./types.ts";

export type * from "./types.ts";

export class EvidenceAttachmentStore {
  constructor(
    readonly database: ApplicationDatabase,
    readonly publicBaseUrl: string,
  ) {}
  async materialize(input: unknown): Promise<EvidencePacket["attachments"]> {
    if (!Array.isArray(input) || input.length > 32)
      throw new MarketDataError("INVALID_EVIDENCE", "attachments must contain at most 32 items");
    let totalBytes = 0;
    const parsed = input.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item))
        throw new MarketDataError("INVALID_EVIDENCE", `attachments[${index}] must be an object`);
      const raw = item as Record<string, unknown>;
      if (
        typeof raw.filename !== "string" ||
        raw.filename.length === 0 ||
        raw.filename.length > 256 ||
        typeof raw.mediaType !== "string" ||
        raw.mediaType.length === 0 ||
        raw.mediaType.length > 128 ||
        typeof raw.contentBase64 !== "string"
      )
        throw new MarketDataError("INVALID_EVIDENCE", `attachments[${index}] is invalid`);
      if (
        raw.contentBase64.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.contentBase64)
      )
        throw new MarketDataError("INVALID_EVIDENCE", `attachments[${index}] is not base64`);
      const content = Buffer.from(raw.contentBase64, "base64");
      if (content.toString("base64") !== raw.contentBase64)
        throw new MarketDataError(
          "INVALID_EVIDENCE",
          `attachments[${index}] is not canonical base64`,
        );
      if (!content.length || content.length > 10 * 1024 * 1024)
        throw new MarketDataError("INVALID_EVIDENCE", "each attachment must be 1 byte to 10 MiB");
      totalBytes += content.length;
      if (totalBytes > 25 * 1024 * 1024)
        throw new MarketDataError("INVALID_EVIDENCE", "attachment packet exceeds 25 MiB");
      const contentHash = attachmentContentHash(content);
      if (raw.contentHash !== undefined && raw.contentHash !== contentHash)
        throw new MarketDataError("TAMPERED_ATTACHMENT", "declared attachment hash is wrong", 409);
      return {
        content,
        reference: {
          byteLength: content.length.toString(),
          contentHash,
          filename: raw.filename,
          mediaType: raw.mediaType,
          uri: `${this.publicBaseUrl}/${contentHash.slice(2)}`,
        },
      };
    });
    await this.database.transaction(async () => {
      for (const { content, reference } of parsed) {
        await this.database.session
          .insert(attachments)
          .values({ contentHash: reference.contentHash, content })
          .onConflictDoNothing();
        assertAttachmentIntegrity(reference, await this.read(reference.contentHash));
      }
    });
    return parsed.map((value) => value.reference);
  }
  async read(contentHash: Hex): Promise<Buffer> {
    const [row] = await this.database.session
      .select({ content: attachments.content })
      .from(attachments)
      .where(eq(attachments.contentHash, contentHash));
    if (!row) throw new MarketDataError("TAMPERED_ATTACHMENT", "attachment is missing", 409);
    if (attachmentContentHash(row.content) !== contentHash)
      throw new MarketDataError("TAMPERED_ATTACHMENT", "stored attachment hash is wrong", 409);
    return row.content;
  }
  async verify(references: EvidencePacket["attachments"]) {
    for (const reference of references)
      assertAttachmentIntegrity(reference, await this.read(reference.contentHash));
  }
}

const parse = <T>(row: { payload: string } | undefined): T | null =>
  row ? JSON.parse(row.payload) : null;
export function createEvidenceQueries(database: ApplicationDatabase) {
  const db = () => database.session;
  // Manual governance writes are serialized across processes, including conflicting packets.
  const locked = <T>(work: () => Promise<T>) => database.locked("evidence:governance", work);
  async function packet(packetHash: Hex) {
    return parse<StoredEvidencePacket>(
      (
        await db()
          .select({ payload: packetRows.payload })
          .from(packetRows)
          .where(eq(packetRows.packetHash, packetHash))
      )[0],
    );
  }
  async function requiredPacket(packetHash: Hex) {
    const stored = await packet(packetHash);
    if (!stored) throw new MarketDataError("NOT_FOUND", "evidence packet not found", 404);
    return stored;
  }
  async function audit(action: string, actor: Address, packetHash: Hex | null, details: unknown) {
    const record: AdminAuditRecord = {
      action,
      actor,
      packetHash,
      details,
      createdAt: new Date().toISOString(),
      id: crypto.randomUUID(),
    };
    await db()
      .insert(actions)
      .values({
        id: record.id,
        action,
        actor: actor.toLowerCase(),
        packetHash,
        createdAt: record.createdAt,
        payload: canonicalStringify(record),
      });
  }
  async function assertNoResolutionConflict(value: ResolutionEvidencePacket) {
    const rows = await db()
      .select({ payload: packetRows.payload })
      .from(packetRows)
      .leftJoin(reviewRows, eq(packetRows.packetHash, reviewRows.packetHash))
      .where(
        and(
          eq(packetRows.kind, "market-resolution"),
          eq(packetRows.marketId, value.localMarket.marketId),
          or(isNull(reviewRows.decision), ne(reviewRows.decision, "reject")),
        ),
      );
    for (const row of rows) {
      const existing = JSON.parse(row.payload) as StoredEvidencePacket;
      if (
        existing.envelope.packet.kind === "market-resolution" &&
        canonicalStringify(existing.envelope.packet.payout) !== canonicalStringify(value.payout)
      )
        throw new MarketDataError(
          "CONFLICTING_EVIDENCE",
          "an active evidence packet for this market has a different payout",
          409,
        );
    }
  }
  async function appendPacket(
    envelope: EvidenceEnvelope<EvidencePacket>,
  ): Promise<StoredEvidencePacket> {
    assertEvidenceIntegrity(envelope);
    return locked(async () => {
      if (envelope.packet.kind === "market-resolution")
        await assertNoResolutionConflict(envelope.packet);
      const existing = await packet(envelope.packetHash);
      if (existing) return existing;
      const stored = { envelope, packetId: crypto.randomUUID() };
      await db()
        .insert(packetRows)
        .values({
          packetHash: envelope.packetHash,
          packetId: stored.packetId,
          kind: envelope.packet.kind,
          marketId:
            envelope.packet.kind === "market-resolution"
              ? envelope.packet.localMarket.marketId
              : null,
          preparer: envelope.packet.preparer.toLowerCase(),
          preparedAt: envelope.packet.preparedAt,
          payload: canonicalStringify(stored),
        });
      const hashes = [
        ...new Set(envelope.packet.attachments.map((reference) => reference.contentHash)),
      ];
      if (hashes.length)
        await db()
          .insert(attachmentLinks)
          .values(hashes.map((contentHash) => ({ packetHash: envelope.packetHash, contentHash })));
      await audit("PACKET_PREPARED", envelope.packet.preparer, envelope.packetHash, {
        kind: envelope.packet.kind,
      });
      return stored;
    });
  }
  async function preparePacket(
    input: unknown,
    publicBaseUrl: string,
    build: (references: EvidencePacket["attachments"]) => EvidenceEnvelope<EvidencePacket>,
  ): Promise<StoredEvidencePacket> {
    return locked(async () => {
      const references = await new EvidenceAttachmentStore(database, publicBaseUrl).materialize(
        input,
      );
      // The builder is pure and synchronous; no RPC or HTTP is allowed in this transaction.
      return appendPacket(build(references));
    });
  }
  async function reviews(packetHash: Hex): Promise<EvidenceReview[]> {
    return (
      await db()
        .select({ payload: reviewRows.payload })
        .from(reviewRows)
        .where(eq(reviewRows.packetHash, packetHash))
        .orderBy(asc(reviewRows.sequence))
    ).map((row) => JSON.parse(row.payload));
  }
  async function appendReview(review: EvidenceReview) {
    return locked(async () => {
      const stored = await requiredPacket(review.packetHash);
      assertEvidenceIntegrity(stored.envelope);
      // API authorization restricts reviews to MARKET_ADMIN. That same wallet may
      // prepare and approve; the explicit, append-only review remains mandatory.
      if ((await reviews(review.packetHash)).length)
        throw new MarketDataError("REVIEW_EXISTS", "packet has already been reviewed", 409);
      await db()
        .insert(reviewRows)
        .values({
          reviewId: review.reviewId,
          packetHash: review.packetHash,
          reviewer: review.reviewer.toLowerCase(),
          decision: review.decision,
          reviewedAt: review.reviewedAt,
          payload: canonicalStringify(review),
        });
      await audit(
        review.decision === "approve" ? "PACKET_APPROVED" : "PACKET_REJECTED",
        review.reviewer,
        review.packetHash,
        { checklist: review.checklist, notes: review.notes },
      );
      return review;
    });
  }
  async function previews(packetHash: Hex): Promise<AdminTransactionPreview[]> {
    return (
      await db()
        .select({ payload: previewRows.payload })
        .from(previewRows)
        .where(eq(previewRows.packetHash, packetHash))
        .orderBy(asc(previewRows.sequence))
    ).map((row) => JSON.parse(row.payload));
  }
  async function appendPreview(preview: AdminTransactionPreview) {
    return locked(async () => {
      const existing = (await previews(preview.packetHash)).find(
        (item) =>
          item.action === preview.action &&
          item.chainId === preview.chainId &&
          item.data === preview.data &&
          item.expectedMarketId === preview.expectedMarketId &&
          item.from.toLowerCase() === preview.from.toLowerCase() &&
          item.to.toLowerCase() === preview.to.toLowerCase() &&
          item.value === preview.value,
      );
      if (existing) return existing;
      await db()
        .insert(previewRows)
        .values({
          previewId: preview.previewId,
          packetHash: preview.packetHash,
          action: preview.action,
          payload: canonicalStringify(preview),
        });
      return preview;
    });
  }
  async function observations(packetHash: Hex): Promise<AdminTransactionObservation[]> {
    return (
      await db()
        .select({ payload: observationRows.payload })
        .from(observationRows)
        .where(eq(observationRows.packetHash, packetHash))
        .orderBy(asc(observationRows.sequence))
    ).map((row) => JSON.parse(row.payload));
  }
  async function appendObservation(observation: AdminTransactionObservation) {
    return locked(async () => {
      const existing = parse<AdminTransactionObservation>(
        (
          await db()
            .select({ payload: observationRows.payload })
            .from(observationRows)
            .where(
              and(
                eq(observationRows.packetHash, observation.packetHash),
                eq(observationRows.transactionHash, observation.transactionHash),
              ),
            )
        )[0],
      );
      if (existing) return existing;
      await db()
        .insert(observationRows)
        .values({
          observationId: observation.observationId,
          packetHash: observation.packetHash,
          transactionHash: observation.transactionHash,
          action: observation.action,
          payload: canonicalStringify(observation),
        });
      return observation;
    });
  }
  async function packetsForMarket(marketId: Hex): Promise<StoredEvidencePacket[]> {
    return (
      await db()
        .select({ payload: packetRows.payload })
        .from(packetRows)
        .where(eq(packetRows.marketId, marketId))
        .orderBy(desc(packetRows.sequence))
    ).map((row) => JSON.parse(row.payload));
  }
  async function latestApprovedPacketForMarket(marketId: Hex) {
    return parse<StoredEvidencePacket>(
      (
        await db()
          .select({ payload: packetRows.payload })
          .from(packetRows)
          .innerJoin(reviewRows, eq(packetRows.packetHash, reviewRows.packetHash))
          .where(and(eq(packetRows.marketId, marketId), eq(reviewRows.decision, "approve")))
          .orderBy(desc(packetRows.sequence))
          .limit(1)
      )[0],
    );
  }
  async function packets(limit = 100): Promise<StoredEvidencePacket[]> {
    return (
      await db()
        .select({ payload: packetRows.payload })
        .from(packetRows)
        .orderBy(desc(packetRows.sequence))
        .limit(boundedLimit(limit))
    ).map((row) => JSON.parse(row.payload));
  }
  async function auditHistory(limit = 250): Promise<AdminAuditRecord[]> {
    return (
      await db()
        .select({ payload: actions.payload })
        .from(actions)
        .orderBy(desc(actions.sequence))
        .limit(boundedLimit(limit, 250, 1000))
    ).map((row) => JSON.parse(row.payload));
  }
  async function status(packetHash: Hex): Promise<EvidenceStatus> {
    const [row] = await db()
      .select({ decision: reviewRows.decision })
      .from(reviewRows)
      .where(eq(reviewRows.packetHash, packetHash));
    return row?.decision === "approve"
      ? "approved"
      : row?.decision === "reject"
        ? "rejected"
        : "prepared";
  }
  async function publishedAttachment(contentHash: Hex): Promise<Buffer | null> {
    const [link] = await db()
      .select({ hash: attachmentLinks.contentHash })
      .from(attachmentLinks)
      .innerJoin(reviewRows, eq(attachmentLinks.packetHash, reviewRows.packetHash))
      .where(and(eq(attachmentLinks.contentHash, contentHash), eq(reviewRows.decision, "approve")))
      .limit(1);
    if (!link) return null;
    return new EvidenceAttachmentStore(database, "").read(contentHash);
  }
  async function viewsForPackets(stored: StoredEvidencePacket[]) {
    if (!stored.length) return [];
    const hashes = stored.map((packet) => packet.envelope.packetHash);
    const related = async <T>(
      table: typeof reviewRows | typeof previewRows | typeof observationRows,
    ) => {
      const rows = await db()
        .select({ packetHash: table.packetHash, payload: table.payload })
        .from(table)
        .where(inArray(table.packetHash, hashes))
        .orderBy(asc(table.sequence));
      const grouped = new Map<string, T[]>();
      for (const row of rows) {
        const list = grouped.get(row.packetHash) ?? [];
        list.push(JSON.parse(row.payload));
        grouped.set(row.packetHash, list);
      }
      return grouped;
    };
    const reviewMap = await related<EvidenceReview>(reviewRows);
    const previewMap = await related<AdminTransactionPreview>(previewRows);
    const observationMap = await related<AdminTransactionObservation>(observationRows);
    return stored.map((packet) => {
      const hash = packet.envelope.packetHash;
      const reviews = reviewMap.get(hash) ?? [];
      return {
        ...packet,
        reviews,
        previews: previewMap.get(hash) ?? [],
        observations: observationMap.get(hash) ?? [],
        status: (reviews[0]?.decision === "approve"
          ? "approved"
          : reviews[0]?.decision === "reject"
            ? "rejected"
            : "prepared") as EvidenceStatus,
      };
    });
  }
  // Governance lock gives these batched reads a consistent view relative to all governance writes.
  async function packetViews(limit = 100) {
    return locked(async () => viewsForPackets(await packets(limit)));
  }
  async function packetView(stored: StoredEvidencePacket) {
    return locked(async () => {
      const view = (await viewsForPackets([stored]))[0];
      if (!view) throw new Error("packet view is missing");
      return view;
    });
  }
  return {
    preparePacket,
    publishedAttachment,
    appendPacket,
    appendReview,
    appendPreview,
    appendObservation,
    packet,
    packetsForMarket,
    latestApprovedPacketForMarket,
    packets,
    auditHistory,
    requiredPacket,
    reviews,
    previews,
    observations,
    status,
    packetView,
    packetViews,
    audit,
    close: database.close,
  };
}
export type EvidenceQueries = ReturnType<typeof createEvidenceQueries>;
