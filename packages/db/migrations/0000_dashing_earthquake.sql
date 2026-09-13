CREATE SCHEMA "gateway";
--> statement-breakpoint
CREATE SCHEMA "matching";
--> statement-breakpoint
CREATE SCHEMA "operations";
--> statement-breakpoint
CREATE SCHEMA "settlement";
--> statement-breakpoint
CREATE SCHEMA "probabl";
--> statement-breakpoint
CREATE TABLE "gateway"."auth_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"message" text NOT NULL,
	"expires_at_ms" numeric(78,0) NOT NULL,
	"consumed_at_ms" numeric(78,0)
);
--> statement-breakpoint
CREATE TABLE "gateway"."auth_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"expires_at_ms" numeric(78,0) NOT NULL,
	"revoked_at_ms" numeric(78,0)
);
--> statement-breakpoint
CREATE TABLE "probabl"."deployment_identity" (
	"id" integer PRIMARY KEY NOT NULL,
	"chain_id" numeric(78,0) NOT NULL,
	"exchange" text NOT NULL,
	"order_version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operations"."evidence_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"sequence" bigserial NOT NULL,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"packet_hash" text,
	"created_at" text NOT NULL,
	"payload" text NOT NULL,
	CONSTRAINT "evidence_actions_sequence_unique" UNIQUE("sequence")
);
--> statement-breakpoint
CREATE TABLE "operations"."evidence_attachments" (
	"content_hash" text PRIMARY KEY NOT NULL,
	"content" "bytea" NOT NULL,
	CONSTRAINT "attachment_size" CHECK (octet_length("operations"."evidence_attachments"."content") BETWEEN 1 AND 10485760)
);
--> statement-breakpoint
CREATE TABLE "operations"."evidence_observations" (
	"observation_id" text PRIMARY KEY NOT NULL,
	"sequence" bigserial NOT NULL,
	"packet_hash" text NOT NULL,
	"transaction_hash" text NOT NULL,
	"action" text NOT NULL,
	"payload" text NOT NULL,
	CONSTRAINT "evidence_observations_sequence_unique" UNIQUE("sequence")
);
--> statement-breakpoint
CREATE TABLE "operations"."evidence_packets" (
	"packet_hash" text PRIMARY KEY NOT NULL,
	"sequence" bigserial NOT NULL,
	"packet_id" text NOT NULL,
	"kind" text NOT NULL,
	"market_id" text,
	"preparer" text NOT NULL,
	"prepared_at" text NOT NULL,
	"payload" text NOT NULL,
	CONSTRAINT "evidence_packets_sequence_unique" UNIQUE("sequence"),
	CONSTRAINT "evidence_packets_packet_id_unique" UNIQUE("packet_id")
);
--> statement-breakpoint
CREATE TABLE "operations"."evidence_previews" (
	"preview_id" text PRIMARY KEY NOT NULL,
	"sequence" bigserial NOT NULL,
	"packet_hash" text NOT NULL,
	"action" text NOT NULL,
	"payload" text NOT NULL,
	CONSTRAINT "evidence_previews_sequence_unique" UNIQUE("sequence")
);
--> statement-breakpoint
CREATE TABLE "operations"."evidence_reviews" (
	"review_id" text PRIMARY KEY NOT NULL,
	"sequence" bigserial NOT NULL,
	"packet_hash" text NOT NULL,
	"reviewer" text NOT NULL,
	"decision" text NOT NULL,
	"reviewed_at" text NOT NULL,
	"payload" text NOT NULL,
	CONSTRAINT "evidence_reviews_sequence_unique" UNIQUE("sequence"),
	CONSTRAINT "evidence_reviews_packet_hash_unique" UNIQUE("packet_hash")
);
--> statement-breakpoint
CREATE TABLE "operations"."freeze_signals" (
	"scope" text PRIMARY KEY NOT NULL,
	"active" boolean NOT NULL,
	"code" text NOT NULL,
	"details" text NOT NULL,
	"detected_at" text NOT NULL,
	"last_seen_at" text NOT NULL,
	"resolved_at" text,
	"run_id" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gateway"."transaction_attempts" (
	"operation_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"transaction_hash" text NOT NULL,
	"payload" text NOT NULL,
	CONSTRAINT "transaction_attempts_operation_id_attempt_pk" PRIMARY KEY("operation_id","attempt"),
	CONSTRAINT "transaction_attempts_transaction_hash_unique" UNIQUE("transaction_hash")
);
--> statement-breakpoint
CREATE TABLE "gateway"."operations" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"sequence" bigserial NOT NULL,
	"address" text NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"order_hash" text,
	"state" text NOT NULL,
	"payload" text NOT NULL,
	CONSTRAINT "operations_sequence_unique" UNIQUE("sequence")
);
--> statement-breakpoint
CREATE TABLE "settlement"."ioc_intents" (
	"intent_id" text PRIMARY KEY NOT NULL,
	"sequence" bigserial NOT NULL,
	"status" text NOT NULL,
	"payload" text NOT NULL,
	CONSTRAINT "ioc_intents_sequence_unique" UNIQUE("sequence")
);
--> statement-breakpoint
CREATE TABLE "matching"."checkpoints" (
	"event_index" numeric(78,0) PRIMARY KEY NOT NULL,
	"payload" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matching"."decisions" (
	"decision_index" bigserial PRIMARY KEY NOT NULL,
	"book_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"payload" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matching"."events" (
	"event_index" bigserial PRIMARY KEY NOT NULL,
	"canonical" boolean NOT NULL,
	"block_number" numeric(78,0) NOT NULL,
	"cursor_key" text NOT NULL,
	"event_hash" text NOT NULL,
	"payload" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matching"."leases" (
	"book_key" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"fencing_token" numeric(78,0) NOT NULL,
	"expires_at_ms" numeric(78,0) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matching"."proposals" (
	"proposal_id" text PRIMARY KEY NOT NULL,
	"book_key" text NOT NULL,
	"status" text NOT NULL,
	"created_after_event_index" numeric(78,0) NOT NULL,
	"payload" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operations"."polymarket_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"sequence" bigserial NOT NULL,
	"condition_id" text,
	"code" text NOT NULL,
	"created_at_ms" numeric(78,0) NOT NULL,
	"payload" text NOT NULL,
	CONSTRAINT "polymarket_alerts_sequence_unique" UNIQUE("sequence")
);
--> statement-breakpoint
CREATE TABLE "operations"."polymarket_heads" (
	"gamma_market_id" text PRIMARY KEY NOT NULL,
	"condition_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"observed_at_ms" numeric(78,0) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operations"."polymarket_snapshots" (
	"snapshot_id" text PRIMARY KEY NOT NULL,
	"gamma_market_id" text NOT NULL,
	"condition_id" text NOT NULL,
	"observed_at_ms" numeric(78,0) NOT NULL,
	"payload" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operations"."polymarket_subscriptions" (
	"condition_id" text PRIMARY KEY NOT NULL,
	"sequence" bigserial NOT NULL,
	"payload" text NOT NULL,
	CONSTRAINT "polymarket_subscriptions_sequence_unique" UNIQUE("sequence")
);
--> statement-breakpoint
CREATE TABLE "operations"."polymarket_ticks" (
	"condition_id" text PRIMARY KEY NOT NULL,
	"observed_at_ms" numeric(78,0) NOT NULL,
	"payload" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operations"."reconciliation_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"completed_at" text NOT NULL,
	"deep" boolean NOT NULL,
	"indexed_block" numeric(78,0) NOT NULL,
	"indexed_block_hash" text NOT NULL,
	"report_hash" text NOT NULL,
	"payload" text NOT NULL,
	CONSTRAINT "reconciliation_runs_report_hash_unique" UNIQUE("report_hash")
);
--> statement-breakpoint
CREATE TABLE "probabl"."relayer_nonces" (
	"chain_id" numeric(78,0) NOT NULL,
	"address" text NOT NULL,
	"next_nonce" numeric(78,0) NOT NULL,
	CONSTRAINT "relayer_nonces_chain_id_address_pk" PRIMARY KEY("chain_id","address"),
	CONSTRAINT "nonnegative_nonce" CHECK ("probabl"."relayer_nonces"."next_nonce" >= 0)
);
--> statement-breakpoint
CREATE TABLE "settlement"."attempts" (
	"batch_id" text NOT NULL,
	"call_index" integer NOT NULL,
	"attempt" integer NOT NULL,
	"transaction_hash" text NOT NULL,
	"nonce" numeric(78,0) NOT NULL,
	"payload" text NOT NULL,
	CONSTRAINT "attempts_batch_id_call_index_attempt_pk" PRIMARY KEY("batch_id","call_index","attempt"),
	CONSTRAINT "attempts_transaction_hash_unique" UNIQUE("transaction_hash")
);
--> statement-breakpoint
CREATE TABLE "settlement"."batches" (
	"batch_id" text PRIMARY KEY NOT NULL,
	"sequence" bigserial NOT NULL,
	"status" text NOT NULL,
	"payload_hash" text NOT NULL,
	"feedback_pending" boolean DEFAULT false NOT NULL,
	"intent_id" text,
	"payload" text NOT NULL,
	CONSTRAINT "batches_sequence_unique" UNIQUE("sequence")
);
--> statement-breakpoint
CREATE TABLE "settlement"."batch_books" (
	"batch_id" text NOT NULL,
	"market_id" text NOT NULL,
	"branch" integer NOT NULL,
	CONSTRAINT "batch_books_batch_id_market_id_branch_pk" PRIMARY KEY("batch_id","market_id","branch")
);
--> statement-breakpoint
ALTER TABLE "operations"."evidence_observations" ADD CONSTRAINT "evidence_observations_packet_hash_evidence_packets_packet_hash_fk" FOREIGN KEY ("packet_hash") REFERENCES "operations"."evidence_packets"("packet_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations"."evidence_previews" ADD CONSTRAINT "evidence_previews_packet_hash_evidence_packets_packet_hash_fk" FOREIGN KEY ("packet_hash") REFERENCES "operations"."evidence_packets"("packet_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations"."evidence_reviews" ADD CONSTRAINT "evidence_reviews_packet_hash_evidence_packets_packet_hash_fk" FOREIGN KEY ("packet_hash") REFERENCES "operations"."evidence_packets"("packet_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations"."freeze_signals" ADD CONSTRAINT "freeze_signals_run_id_reconciliation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "operations"."reconciliation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway"."transaction_attempts" ADD CONSTRAINT "transaction_attempts_operation_id_operations_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "gateway"."operations"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations"."polymarket_heads" ADD CONSTRAINT "polymarket_heads_snapshot_id_polymarket_snapshots_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "operations"."polymarket_snapshots"("snapshot_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement"."attempts" ADD CONSTRAINT "attempts_batch_id_batches_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "settlement"."batches"("batch_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement"."batch_books" ADD CONSTRAINT "batch_books_batch_id_batches_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "settlement"."batches"("batch_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "challenges_expiry_idx" ON "gateway"."auth_challenges" USING btree ("expires_at_ms");--> statement-breakpoint
CREATE INDEX "sessions_expiry_idx" ON "gateway"."auth_sessions" USING btree ("expires_at_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_observation_tx_idx" ON "operations"."evidence_observations" USING btree ("packet_hash","transaction_hash");--> statement-breakpoint
CREATE INDEX "evidence_observation_packet_idx" ON "operations"."evidence_observations" USING btree ("packet_hash","sequence");--> statement-breakpoint
CREATE INDEX "evidence_market_idx" ON "operations"."evidence_packets" USING btree ("market_id","kind","sequence");--> statement-breakpoint
CREATE INDEX "evidence_preview_packet_idx" ON "operations"."evidence_previews" USING btree ("packet_hash","sequence");--> statement-breakpoint
CREATE INDEX "freeze_active_idx" ON "operations"."freeze_signals" USING btree ("scope") WHERE "operations"."freeze_signals"."active";--> statement-breakpoint
CREATE UNIQUE INDEX "operation_idempotency_idx" ON "gateway"."operations" USING btree ("address","kind","idempotency_key");--> statement-breakpoint
CREATE INDEX "operation_order_hash_idx" ON "gateway"."operations" USING btree ("address","order_hash","sequence");--> statement-breakpoint
CREATE INDEX "operation_pending_idx" ON "gateway"."operations" USING btree ("sequence") WHERE "gateway"."operations"."state" NOT IN ('canonical','failed');--> statement-breakpoint
CREATE INDEX "ioc_waiting_idx" ON "settlement"."ioc_intents" USING btree ("sequence") WHERE "settlement"."ioc_intents"."status" = 'waiting-match';--> statement-breakpoint
CREATE INDEX "matcher_decision_book_idx" ON "matching"."decisions" USING btree ("book_key","decision_index");--> statement-breakpoint
CREATE UNIQUE INDEX "matcher_canonical_cursor_idx" ON "matching"."events" USING btree ("cursor_key") WHERE "matching"."events"."canonical";--> statement-breakpoint
CREATE INDEX "matcher_canonical_index_idx" ON "matching"."events" USING btree ("event_index") WHERE "matching"."events"."canonical";--> statement-breakpoint
CREATE INDEX "matcher_canonical_block_idx" ON "matching"."events" USING btree ("block_number") WHERE "matching"."events"."canonical";--> statement-breakpoint
CREATE INDEX "matcher_active_idx" ON "matching"."proposals" USING btree ("created_after_event_index") WHERE "matching"."proposals"."status" IN ('persisted','submitted','mined');--> statement-breakpoint
CREATE UNIQUE INDEX "matcher_active_book_idx" ON "matching"."proposals" USING btree ("book_key") WHERE "matching"."proposals"."status" IN ('persisted','submitted','mined');--> statement-breakpoint
CREATE INDEX "polymarket_head_condition_idx" ON "operations"."polymarket_heads" USING btree ("condition_id","observed_at_ms","gamma_market_id");--> statement-breakpoint
CREATE INDEX "reconciliation_deep_idx" ON "operations"."reconciliation_runs" USING btree ("id") WHERE "operations"."reconciliation_runs"."deep";--> statement-breakpoint
CREATE INDEX "settlement_pending_idx" ON "settlement"."batches" USING btree ("sequence") WHERE "settlement"."batches"."status" IN ('queued','simulated','submitted','mined');--> statement-breakpoint
CREATE INDEX "settlement_feedback_idx" ON "settlement"."batches" USING btree ("sequence") WHERE "settlement"."batches"."feedback_pending";--> statement-breakpoint
CREATE INDEX "settlement_intent_idx" ON "settlement"."batches" USING btree ("intent_id","sequence");--> statement-breakpoint
CREATE INDEX "settlement_book_idx" ON "settlement"."batch_books" USING btree ("market_id","branch");