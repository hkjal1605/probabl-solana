-- Run once, after Drizzle migrations, as the PostgreSQL/Aurora administrative owner.
-- These are NOLOGIN privilege groups, not credentials. Create individual service logins
-- (or IAM-authenticated users) separately and GRANT the corresponding group to each.
-- Runtime users must NOT own the database/tables, inherit the migration owner, or have
-- SUPERUSER/CREATEROLE/BYPASSRLS. Never run application services with the migration URL.
BEGIN;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'probabl_gateway_role',
    'probabl_polymarket_role', 'probabl_reconciler_role', 'probabl_indexer_role'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', role_name);
    ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name AND
      (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
      RAISE EXCEPTION 'refusing unsafe existing privilege group %', role_name;
    END IF;
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), role_name);
  END LOOP;
  -- Ponder creates its own explicitly configured projection/cache schemas only.
  EXECUTE format('GRANT CREATE ON DATABASE %I TO probabl_indexer_role', current_database());
END;
$$;
REVOKE ALL ON SCHEMA probabl, gateway, operations, probabl_migrations FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA probabl TO probabl_gateway_role,
  probabl_polymarket_role, probabl_reconciler_role, probabl_indexer_role;
GRANT SELECT ON probabl.deployment_identity TO probabl_gateway_role,
  probabl_polymarket_role, probabl_reconciler_role, probabl_indexer_role;
GRANT USAGE ON SCHEMA probabl_migrations TO probabl_gateway_role,
  probabl_polymarket_role, probabl_reconciler_role, probabl_indexer_role;
GRANT SELECT ON probabl_migrations.__drizzle_migrations TO probabl_gateway_role,
  probabl_polymarket_role, probabl_reconciler_role, probabl_indexer_role;

GRANT USAGE ON SCHEMA gateway, operations TO probabl_gateway_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON gateway.auth_challenges, gateway.auth_sessions TO probabl_gateway_role;
GRANT SELECT, INSERT, UPDATE ON gateway.operations TO probabl_gateway_role;
GRANT SELECT, INSERT ON gateway.transaction_attempts TO probabl_gateway_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA gateway TO probabl_gateway_role;
GRANT SELECT, INSERT ON operations.evidence_packets, operations.evidence_reviews,
  operations.evidence_previews, operations.evidence_observations, operations.evidence_actions,
  operations.evidence_attachments, operations.evidence_attachment_links TO probabl_gateway_role;
GRANT USAGE, SELECT ON SEQUENCE operations.evidence_packets_sequence_seq,
  operations.evidence_reviews_sequence_seq, operations.evidence_previews_sequence_seq,
  operations.evidence_observations_sequence_seq, operations.evidence_actions_sequence_seq TO probabl_gateway_role;



GRANT USAGE ON SCHEMA operations TO probabl_polymarket_role, probabl_reconciler_role;
GRANT SELECT, INSERT ON operations.polymarket_snapshots, operations.polymarket_subscriptions,
  operations.polymarket_alerts TO probabl_polymarket_role;
GRANT SELECT, INSERT, UPDATE ON operations.polymarket_heads, operations.polymarket_ticks TO probabl_polymarket_role;
GRANT USAGE, SELECT ON SEQUENCE operations.polymarket_subscriptions_sequence_seq,
  operations.polymarket_alerts_sequence_seq TO probabl_polymarket_role;
GRANT SELECT, INSERT ON operations.reconciliation_runs TO probabl_reconciler_role;
GRANT SELECT, INSERT, UPDATE ON operations.freeze_signals TO probabl_reconciler_role;
GRANT USAGE, SELECT ON SEQUENCE operations.reconciliation_runs_id_seq TO probabl_reconciler_role;
COMMIT;
