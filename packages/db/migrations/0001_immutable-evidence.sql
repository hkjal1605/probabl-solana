-- Runtime credentials must not own these tables or be able to disable triggers.
-- Content-addressed evidence and audit records can be appended, never rewritten.
CREATE FUNCTION operations.reject_immutable_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable protocol record: %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
DO $$
DECLARE target regclass;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'probabl.deployment_identity'::regclass,
    'operations.evidence_packets'::regclass,
    'operations.evidence_reviews'::regclass,
    'operations.evidence_previews'::regclass,
    'operations.evidence_observations'::regclass,
    'operations.evidence_actions'::regclass,
    'operations.evidence_attachments'::regclass,
    'operations.polymarket_snapshots'::regclass,
    'operations.polymarket_subscriptions'::regclass,
    'operations.polymarket_alerts'::regclass,
    'operations.reconciliation_runs'::regclass
  ] LOOP
    EXECUTE format('CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION operations.reject_immutable_mutation()', target);
    EXECUTE format('CREATE TRIGGER immutable_table BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION operations.reject_immutable_mutation()', target);
  END LOOP;
END;
$$;
