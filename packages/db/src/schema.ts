import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  bigint as pgBigint,
  pgSchema,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// EVM and cursor integers never pass through JavaScript Number or PostgreSQL int8.
export const uint = customType<{ data: bigint; driverData: string }>({
  dataType: () => "numeric(78,0)",
  toDriver: (value) => {
    if (value < 0n || value >= 1n << 256n) throw new RangeError("uint256 out of range");
    return value.toString();
  },
  fromDriver: (value) => BigInt(value),
});
const bytes = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
export const sharedSchema = pgSchema("probabl");
export const gatewaySchema = pgSchema("gateway");
export const operationsSchema = pgSchema("operations");
const sequence = () => bigserial("sequence", { mode: "bigint" }).notNull().unique();
const payload = () => text("payload").notNull();

export const deploymentIdentity = sharedSchema.table("deployment_identity", {
  id: integer("id").primaryKey(),
  chainId: uint("chain_id").notNull(),
  exchange: text("exchange").notNull(),
  orderVersion: integer("order_version").notNull(),
});
export const authChallenges = gatewaySchema.table(
  "auth_challenges",
  {
    id: text("id").primaryKey(),
    address: text("address").notNull(),
    message: text("message").notNull(),
    expiresAtMs: uint("expires_at_ms").notNull(),
    consumedAtMs: uint("consumed_at_ms"),
  },
  (t) => [index("challenges_expiry_idx").on(t.expiresAtMs)],
);
export const authSessions = gatewaySchema.table(
  "auth_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    address: text("address").notNull(),
    expiresAtMs: uint("expires_at_ms").notNull(),
    revokedAtMs: uint("revoked_at_ms"),
  },
  (t) => [index("sessions_expiry_idx").on(t.expiresAtMs)],
);
export const gatewayOperations = gatewaySchema.table(
  "operations",
  {
    operationId: text("operation_id").primaryKey(),
    sequence: sequence(),
    address: text("address").notNull(),
    kind: text("kind").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    leaseToken: uint("lease_token").notNull().default(sql`0`),
    leaseExpiresAtMs: uint("lease_expires_at_ms").notNull().default(sql`0`),
    orderHash: text("order_hash"),
    state: text("state").notNull(),
    payload: payload(),
  },
  (t) => [
    uniqueIndex("operation_idempotency_idx").on(t.address, t.kind, t.idempotencyKey),
    index("operation_order_hash_idx").on(t.address, t.orderHash, t.sequence),
    index("operation_pending_idx")
      .on(t.sequence)
      .where(sql`${t.state} NOT IN ('canonical','failed')`),
  ],
);
export const gatewayAttempts = gatewaySchema.table(
  "transaction_attempts",
  {
    operationId: text("operation_id")
      .notNull()
      .references(() => gatewayOperations.operationId),
    attempt: integer("attempt").notNull(),
    transactionHash: text("transaction_hash").notNull().unique(),
    payload: payload(),
  },
  (t) => [primaryKey({ columns: [t.operationId, t.attempt] })],
);

export const evidencePackets = operationsSchema.table(
  "evidence_packets",
  {
    packetHash: text("packet_hash").primaryKey(),
    sequence: sequence(),
    packetId: text("packet_id").notNull().unique(),
    kind: text("kind").notNull(),
    marketId: text("market_id"),
    preparer: text("preparer").notNull(),
    preparedAt: text("prepared_at").notNull(),
    payload: payload(),
  },
  (t) => [index("evidence_market_idx").on(t.marketId, t.kind, t.sequence)],
);
export const evidenceReviews = operationsSchema.table("evidence_reviews", {
  reviewId: text("review_id").primaryKey(),
  sequence: sequence(),
  packetHash: text("packet_hash")
    .notNull()
    .unique()
    .references(() => evidencePackets.packetHash),
  reviewer: text("reviewer").notNull(),
  decision: text("decision").notNull(),
  reviewedAt: text("reviewed_at").notNull(),
  payload: payload(),
});
export const evidencePreviews = operationsSchema.table(
  "evidence_previews",
  {
    previewId: text("preview_id").primaryKey(),
    sequence: sequence(),
    packetHash: text("packet_hash")
      .notNull()
      .references(() => evidencePackets.packetHash),
    action: text("action").notNull(),
    payload: payload(),
  },
  (t) => [index("evidence_preview_packet_idx").on(t.packetHash, t.sequence)],
);
export const evidenceObservations = operationsSchema.table(
  "evidence_observations",
  {
    observationId: text("observation_id").primaryKey(),
    sequence: sequence(),
    packetHash: text("packet_hash")
      .notNull()
      .references(() => evidencePackets.packetHash),
    transactionHash: text("transaction_hash").notNull(),
    action: text("action").notNull(),
    payload: payload(),
  },
  (t) => [
    uniqueIndex("evidence_observation_tx_idx").on(t.packetHash, t.transactionHash),
    index("evidence_observation_packet_idx").on(t.packetHash, t.sequence),
  ],
);
export const evidenceActions = operationsSchema.table("evidence_actions", {
  id: text("id").primaryKey(),
  sequence: sequence(),
  action: text("action").notNull(),
  actor: text("actor").notNull(),
  packetHash: text("packet_hash"),
  createdAt: text("created_at").notNull(),
  payload: payload(),
});
export const evidenceAttachments = operationsSchema.table(
  "evidence_attachments",
  {
    contentHash: text("content_hash").primaryKey(),
    content: bytes("content").notNull(),
  },
  (t) => [check("attachment_size", sql`octet_length(${t.content}) BETWEEN 1 AND 10485760`)],
);
export const evidenceAttachmentLinks = operationsSchema.table(
  "evidence_attachment_links",
  {
    packetHash: text("packet_hash")
      .notNull()
      .references(() => evidencePackets.packetHash),
    contentHash: text("content_hash")
      .notNull()
      .references(() => evidenceAttachments.contentHash),
  },
  (t) => [
    primaryKey({ columns: [t.packetHash, t.contentHash] }),
    index("evidence_attachment_content_idx").on(t.contentHash, t.packetHash),
  ],
);

export const polymarketSnapshots = operationsSchema.table("polymarket_snapshots", {
  snapshotId: text("snapshot_id").primaryKey(),
  gammaMarketId: text("gamma_market_id").notNull(),
  conditionId: text("condition_id").notNull(),
  observedAtMs: uint("observed_at_ms").notNull(),
  payload: payload(),
});
export const polymarketHeads = operationsSchema.table(
  "polymarket_heads",
  {
    gammaMarketId: text("gamma_market_id").primaryKey(),
    conditionId: text("condition_id").notNull(),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => polymarketSnapshots.snapshotId),
    observedAtMs: uint("observed_at_ms").notNull(),
  },
  (t) => [
    index("polymarket_head_condition_idx").on(t.conditionId, t.observedAtMs, t.gammaMarketId),
  ],
);
export const polymarketTicks = operationsSchema.table("polymarket_ticks", {
  conditionId: text("condition_id").primaryKey(),
  observedAtMs: uint("observed_at_ms").notNull(),
  payload: payload(),
});
export const polymarketSubscriptions = operationsSchema.table("polymarket_subscriptions", {
  conditionId: text("condition_id").primaryKey(),
  sequence: sequence(),
  payload: payload(),
});
export const polymarketAlerts = operationsSchema.table("polymarket_alerts", {
  id: text("id").primaryKey(),
  sequence: sequence(),
  conditionId: text("condition_id"),
  code: text("code").notNull(),
  createdAtMs: uint("created_at_ms").notNull(),
  payload: payload(),
});
export const reconciliationRuns = operationsSchema.table(
  "reconciliation_runs",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    completedAt: text("completed_at").notNull(),
    deep: boolean("deep").notNull(),
    indexedBlock: uint("indexed_block").notNull(),
    indexedBlockHash: text("indexed_block_hash").notNull(),
    reportHash: text("report_hash").notNull().unique(),
    payload: payload(),
  },
  (t) => [index("reconciliation_deep_idx").on(t.id).where(sql`${t.deep}`)],
);
export const freezeSignals = operationsSchema.table(
  "freeze_signals",
  {
    scope: text("scope").primaryKey(),
    active: boolean("active").notNull(),
    code: text("code").notNull(),
    details: text("details").notNull(),
    detectedAt: text("detected_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    resolvedAt: text("resolved_at"),
    runId: pgBigint("run_id", { mode: "bigint" })
      .notNull()
      .references(() => reconciliationRuns.id),
  },
  (t) => [index("freeze_active_idx").on(t.scope).where(sql`${t.active}`)],
);
