import type { Pool } from "pg";
/** 4: multi-issuer markets (12-asset layout, protocolVersion 3 JSON). */
export const SNAPSHOT_VERSION = 4;
/** Fresh schema only. Refuse to silently serve old custody data after a restart. */
export async function initializeStorage(db: Pool) {
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('solana-storage-schema'))");
    await tx.query(
      "CREATE TABLE IF NOT EXISTS solana_schema (id boolean PRIMARY KEY DEFAULT true CHECK(id), version integer NOT NULL)",
    );
    const version = await tx.query("SELECT version FROM solana_schema WHERE id=true");
    if (version.rows[0] && version.rows[0].version !== SNAPSHOT_VERSION)
      throw new Error("Fresh Solana database/schema required");
    if (!version.rows.length) {
      const old = await tx.query("SELECT to_regclass('solana_snapshots') AS existing");
      if (old.rows[0]?.existing)
        throw new Error("Legacy Solana custody schema: configure a fresh database/schema");
      await tx.query("INSERT INTO solana_schema VALUES(true,$1)", [SNAPSHOT_VERSION]);
    }
    await tx.query(`CREATE TABLE IF NOT EXISTS solana_snapshots (
      domain text PRIMARY KEY, slot bigint NOT NULL CHECK(slot>=0), observed_at timestamptz NOT NULL, accounts jsonb NOT NULL)`);
    await tx.query(`CREATE TABLE IF NOT EXISTS solana_asset_pools (
      domain text NOT NULL, address text NOT NULL, mint text NOT NULL, token_program text NOT NULL,
      decimals integer NOT NULL CHECK(decimals BETWEEN 0 AND 255),
      liability numeric(20,0) NOT NULL CHECK(liability BETWEEN 0 AND 18446744073709551615),
      slot bigint NOT NULL, PRIMARY KEY(domain,address), UNIQUE(domain,mint))`);
    await tx.query(`CREATE TABLE IF NOT EXISTS solana_asset_credits (
      domain text NOT NULL, address text NOT NULL, pool text NOT NULL, owner text NOT NULL,
      available numeric(20,0) NOT NULL CHECK(available BETWEEN 0 AND 18446744073709551615),
      slot bigint NOT NULL, PRIMARY KEY(domain,address), UNIQUE(domain,pool,owner),
      FOREIGN KEY(domain,pool) REFERENCES solana_asset_pools(domain,address))`);
    await tx.query(
      "CREATE INDEX IF NOT EXISTS solana_credits_owner ON solana_asset_credits(domain,owner)",
    );
    await tx.query(`CREATE TABLE IF NOT EXISTS solana_market_claims (
      domain text NOT NULL, market text NOT NULL, owner text NOT NULL, mint text NOT NULL,
      asset integer NOT NULL CHECK(asset BETWEEN 1 AND 11 AND asset % 3 <> 0),
      available numeric(20,0) NOT NULL CHECK(available BETWEEN 0 AND 18446744073709551615),
      slot bigint NOT NULL, PRIMARY KEY(domain,market,owner,asset))`);
    await tx.query(
      "CREATE INDEX IF NOT EXISTS solana_claims_owner ON solana_market_claims(domain,owner)",
    );
    // Keeper-maintained append-only address lookup tables (see solana-client lookup.ts).
    await tx.query(`CREATE TABLE IF NOT EXISTS solana_lookup_tables (
      domain text NOT NULL, address text NOT NULL, authority text NOT NULL,
      created_slot bigint NOT NULL CHECK(created_slot>=0), created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(domain,address))`);
    await tx.query(`CREATE TABLE IF NOT EXISTS solana_history_cursors (
      domain text PRIMARY KEY, signature text NOT NULL, slot bigint NOT NULL, snapshot_slot bigint NOT NULL)`);
    await tx.query(`CREATE TABLE IF NOT EXISTS solana_events (
      domain text NOT NULL, signature text NOT NULL, event_index integer NOT NULL,
      slot bigint NOT NULL, block_time bigint NOT NULL, name text NOT NULL, market text, data jsonb NOT NULL,
      PRIMARY KEY(domain,signature,event_index))`);
    await tx.query(
      "CREATE INDEX IF NOT EXISTS solana_events_market ON solana_events(domain,market,slot DESC)",
    );
    await tx.query(
      "CREATE INDEX IF NOT EXISTS solana_events_pool ON solana_events(domain,(data->>'pool'),slot DESC) WHERE name='PoolChange'",
    );
    await tx.query(`CREATE TABLE IF NOT EXISTS solana_wallet_snapshots (
      domain text NOT NULL, owner text NOT NULL, observed_at timestamptz NOT NULL, data jsonb NOT NULL, PRIMARY KEY(domain,owner))`);
    await tx.query(`CREATE TABLE IF NOT EXISTS solana_delegated_submissions (
      domain text NOT NULL, order_hash text NOT NULL, order_terms_hash text NOT NULL,
      owner text NOT NULL, delegate text NOT NULL,
      signature text NOT NULL, signed_transaction bytea NOT NULL, last_valid_block_height bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(domain,order_hash))`);
    await tx.query(`CREATE INDEX IF NOT EXISTS solana_delegated_submissions_owner_day
      ON solana_delegated_submissions(domain,owner,created_at)`);
    await tx.query(`CREATE TABLE IF NOT EXISTS solana_auth_challenges (
      id text PRIMARY KEY, domain text NOT NULL, owner text NOT NULL, message text NOT NULL, expires_at timestamptz NOT NULL)`);
    await tx.query(`CREATE TABLE IF NOT EXISTS solana_sessions (
      token_hash text PRIMARY KEY, domain text NOT NULL, owner text NOT NULL, expires_at timestamptz NOT NULL)`);
    await tx.query(
      "CREATE INDEX IF NOT EXISTS solana_auth_owner ON solana_auth_challenges(domain,owner)",
    );
    await tx.query(`CREATE TABLE IF NOT EXISTS solana_evidence (
      domain text NOT NULL, hash text NOT NULL, envelope jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(domain,hash))`);
    await tx.query(`CREATE TABLE IF NOT EXISTS solana_evidence_actions (
      id uuid PRIMARY KEY, domain text NOT NULL, packet_hash text NOT NULL, kind text NOT NULL, actor text NOT NULL,
      payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
    await tx.query(
      "CREATE INDEX IF NOT EXISTS solana_evidence_actions_packet ON solana_evidence_actions(domain,packet_hash,created_at)",
    );
    await tx.query(`CREATE TABLE IF NOT EXISTS solana_attachments (
      domain text NOT NULL, hash text NOT NULL, content bytea NOT NULL, PRIMARY KEY(domain,hash))`);
    await tx.query("COMMIT");
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
