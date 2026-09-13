ALTER TABLE "gateway"."operations" ADD COLUMN "lease_token" numeric(78,0) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "gateway"."operations" ADD COLUMN "lease_expires_at_ms" numeric(78,0) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "matching"."proposals" ADD COLUMN "last_canonical_event_index" numeric(78,0);--> statement-breakpoint
CREATE INDEX "matcher_proposal_created_idx" ON "matching"."proposals" USING btree ("created_after_event_index");--> statement-breakpoint
CREATE INDEX "matcher_proposal_canonical_idx" ON "matching"."proposals" USING btree ("last_canonical_event_index");--> statement-breakpoint
UPDATE "matching"."proposals" SET "last_canonical_event_index" =
  (payload::jsonb -> 'lastCanonicalEventIndex' ->> '$bigint')::numeric
WHERE payload::jsonb -> 'lastCanonicalEventIndex' IS DISTINCT FROM 'null'::jsonb;
