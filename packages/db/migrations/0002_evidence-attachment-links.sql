CREATE TABLE "operations"."evidence_attachment_links" (
	"packet_hash" text NOT NULL,
	"content_hash" text NOT NULL,
	CONSTRAINT "evidence_attachment_links_packet_hash_content_hash_pk" PRIMARY KEY("packet_hash","content_hash")
);
--> statement-breakpoint
ALTER TABLE "operations"."evidence_attachment_links" ADD CONSTRAINT "evidence_attachment_links_packet_hash_evidence_packets_packet_hash_fk" FOREIGN KEY ("packet_hash") REFERENCES "operations"."evidence_packets"("packet_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations"."evidence_attachment_links" ADD CONSTRAINT "evidence_attachment_links_content_hash_evidence_attachments_content_hash_fk" FOREIGN KEY ("content_hash") REFERENCES "operations"."evidence_attachments"("content_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_attachment_content_idx" ON "operations"."evidence_attachment_links" USING btree ("content_hash","packet_hash");
--> statement-breakpoint
CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON operations.evidence_attachment_links FOR EACH ROW EXECUTE FUNCTION operations.reject_immutable_mutation();
--> statement-breakpoint
CREATE TRIGGER immutable_table BEFORE TRUNCATE ON operations.evidence_attachment_links FOR EACH STATEMENT EXECUTE FUNCTION operations.reject_immutable_mutation();
