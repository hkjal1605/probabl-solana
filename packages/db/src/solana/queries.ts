import type { Pool, PoolClient } from "pg";
import { SignInCapacityError } from "./errors";
import type { HistoryCursor, SnapshotWrite, StoredEvent } from "./types";

/** The only SQL surface for Solana services. Never expose a generic query method. */
export function solanaQueries(db: Pick<Pool | PoolClient, "query">) {
  return {
    async ping() {
      await db.query("SELECT 1");
    },
    async eventCount(domain: string) {
      return Number(
        (
          await db.query<{ count: string }>("SELECT count(*) FROM solana_events WHERE domain=$1", [
            domain,
          ])
        ).rows[0]!.count,
      );
    },
    /** Keeper lookup tables, oldest first (clients reference only what they use). */
    async lookupTables(domain: string): Promise<string[]> {
      const result = await db.query(
        "SELECT address FROM solana_lookup_tables WHERE domain=$1 ORDER BY created_at, address",
        [domain],
      );
      return result.rows.map((row: { address: string }) => row.address);
    },
    async putLookupTable(domain: string, address: string, authority: string, slot: number) {
      await db.query(
        "INSERT INTO solana_lookup_tables(domain,address,authority,created_slot) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [domain, address, authority, slot],
      );
    },
    async historyCursor(domain: string) {
      return (
        await db.query<HistoryCursor>("SELECT * FROM solana_history_cursors WHERE domain=$1", [
          domain,
        ])
      ).rows[0];
    },
    async putEvent(domain: string, e: StoredEvent) {
      await db.query(
        "INSERT INTO solana_events VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT DO NOTHING",
        [
          domain,
          e.signature,
          e.event_index,
          e.slot,
          e.block_time,
          e.name,
          e.market,
          JSON.stringify(e.data),
        ],
      );
    },
    async putHistoryCursor(domain: string, c: HistoryCursor) {
      await db.query(
        `INSERT INTO solana_history_cursors VALUES($1,$2,$3,$4)
        ON CONFLICT(domain) DO UPDATE SET signature=EXCLUDED.signature,slot=EXCLUDED.slot,snapshot_slot=EXCLUDED.snapshot_slot`,
        [domain, c.signature, c.slot, c.snapshot_slot],
      );
    },
    async creationEvents(domain: string, slot: number) {
      return (
        await db.query<{ market: string; block_time: string }>(
          `SELECT market,MIN(block_time)::text AS block_time FROM solana_events
        WHERE domain=$1 AND name='Change' AND data->>'kind'='1' AND slot <= $2 GROUP BY market`,
          [domain, slot],
        )
      ).rows;
    },
    async retiredEvents(domain: string, slot: number) {
      return (
        await db.query(
          "SELECT data FROM solana_events WHERE domain=$1 AND name='OrderRetired' AND slot <= $2 ORDER BY slot,event_index",
          [domain, slot],
        )
      ).rows;
    },
    async resolutionEvent(domain: string, market: string, slot: number) {
      return (
        await db.query(
          `SELECT signature,data FROM solana_events WHERE domain=$1 AND market=$2 AND name='Change'
        AND data->>'kind'='3' AND slot <= $3 ORDER BY slot DESC LIMIT 1`,
          [domain, market, slot],
        )
      ).rows[0];
    },
    /** Base-leg listing (Change kind 15, amount = scale) and active toggles
     * (kind 16, amount 0/1), oldest first. `asset` is the leg's collateral. */
    async legEvents(domain: string, market: string, slot: number) {
      return (
        await db.query<StoredEvent>(
          `SELECT signature,event_index,slot,block_time,name,market,data FROM solana_events
        WHERE domain=$1 AND market=$2 AND name='Change' AND data->>'kind' IN ('15','16') AND slot <= $3
        ORDER BY slot,signature,event_index LIMIT 1000`,
          [domain, market, slot],
        )
      ).rows;
    },
    async trades(domain: string, markets: string[], slot: number, limit: number) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw new Error("Invalid trade limit");
      return (
        await db.query(
          `SELECT * FROM solana_events WHERE domain=$1 AND name='Trade' AND market=ANY($2::text[])
        AND slot <= $3 ORDER BY slot DESC,signature DESC,event_index DESC LIMIT $4`,
          [domain, markets, slot, limit],
        )
      ).rows;
    },
    async failSnapshot(domain: string, slot: number) {
      await db.query(
        "UPDATE solana_snapshots SET accounts=jsonb_set(accounts,'{healthy}','false') WHERE domain=$1 AND slot <= $2",
        [domain, slot],
      );
    },
    async snapshot(domain: string, schema?: string) {
      if (schema && !/^[a-z_][a-z0-9_]*$/.test(schema))
        throw new Error("Invalid indexer snapshot schema");
      const table = schema ? `"${schema}".solana_snapshots` : "solana_snapshots";
      return (
        await db.query(
          `SELECT slot,accounts,extract(epoch from observed_at)*1000 AS observed_at_ms FROM ${table}
        WHERE domain=$1 AND observed_at > now()-interval '15 seconds' AND accounts->>'healthy'='true'`,
          [domain],
        )
      ).rows[0];
    },
    async putWallet(
      domain: string,
      owner: string,
      image: { observedAt: number; blockNumber: string },
    ) {
      await db.query(
        `INSERT INTO solana_wallet_snapshots VALUES($1,$2,to_timestamp($4::double precision/1000),$3::jsonb)
        ON CONFLICT(domain,owner) DO UPDATE SET observed_at=EXCLUDED.observed_at,data=EXCLUDED.data
        WHERE (solana_wallet_snapshots.data->>'blockNumber')::bigint <= (EXCLUDED.data->>'blockNumber')::bigint`,
        [domain, owner, JSON.stringify(image), image.observedAt],
      );
    },
    async delegatedSubmission(domain: string, orderHash: string) {
      return (
        await db.query<{
          order_terms_hash: string;
          owner: string;
          delegate: string;
          signature: string;
          signed_transaction: Buffer;
          last_valid_block_height: string;
        }>(
          "SELECT order_terms_hash,owner,delegate,signature,signed_transaction,last_valid_block_height FROM solana_delegated_submissions WHERE domain=$1 AND order_hash=$2",
          [domain, orderHash],
        )
      ).rows[0];
    },
    async delegatedSubmissionCount(domain: string, owner: string) {
      return Number(
        (
          await db.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM solana_delegated_submissions WHERE domain=$1 AND owner=$2 AND created_at>now()-interval '1 day'",
            [domain, owner],
          )
        ).rows[0]!.count,
      );
    },
    async recordDelegatedSubmission(
      domain: string,
      orderHash: string,
      orderTermsHash: string,
      owner: string,
      delegate: string,
      signature: string,
      signedTransaction: Uint8Array,
      lastValidBlockHeight: number,
    ) {
      await db.query(
        `INSERT INTO solana_delegated_submissions
        (domain,order_hash,order_terms_hash,owner,delegate,signature,signed_transaction,last_valid_block_height)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(domain,order_hash) DO NOTHING`,
        [
          domain,
          orderHash,
          orderTermsHash,
          owner,
          delegate,
          signature,
          Buffer.from(signedTransaction),
          lastValidBlockHeight,
        ],
      );
      return (
        await db.query<{
          order_terms_hash: string;
          owner: string;
          delegate: string;
          signature: string;
          signed_transaction: Buffer;
          last_valid_block_height: string;
        }>(
          "SELECT order_terms_hash,owner,delegate,signature,signed_transaction,last_valid_block_height FROM solana_delegated_submissions WHERE domain=$1 AND order_hash=$2",
          [domain, orderHash],
        )
      ).rows[0]!;
    },
    async sessionOwner(domain: string, hash: string) {
      return (
        await db.query<{ owner: string }>(
          "SELECT owner FROM solana_sessions WHERE token_hash=$1 AND domain=$2 AND expires_at>now()",
          [hash, domain],
        )
      ).rows[0]?.owner;
    },
    async challenge(domain: string, owner: string, id: string) {
      return (
        await db.query<{ message: string }>(
          "SELECT message FROM solana_auth_challenges WHERE id=$1 AND domain=$2 AND owner=$3 AND expires_at>now()",
          [id, domain, owner],
        )
      ).rows[0]?.message;
    },
    async createChallenge(domain: string, owner: string, id: string, message: string) {
      await db.query("DELETE FROM solana_auth_challenges WHERE expires_at<=now()");
      await db.query("DELETE FROM solana_sessions WHERE expires_at<=now()");
      const counts = await db.query<{ total: string; owned: string }>(
        "SELECT count(*)::text AS total,count(*) FILTER (WHERE owner=$2)::text AS owned FROM solana_auth_challenges WHERE domain=$1",
        [domain, owner],
      );
      if (Number(counts.rows[0]!.total) >= 1000)
        throw new SignInCapacityError(
          "Sign-in capacity reached; retry after outstanding challenges expire",
        );
      if (Number(counts.rows[0]!.owned) >= 5)
        throw new SignInCapacityError("Too many pending sign-in requests");
      await db.query(
        "INSERT INTO solana_auth_challenges VALUES($1,$2,$3,$4,now()+interval '2 minutes')",
        [id, domain, owner, message],
      );
    },
    async consumeChallenge(domain: string, owner: string, id: string, hash: string) {
      const consumed = await db.query(
        "DELETE FROM solana_auth_challenges WHERE id=$1 AND domain=$2 AND owner=$3 AND expires_at>now() RETURNING id",
        [id, domain, owner],
      );
      if (consumed.rowCount !== 1) throw new Error("Challenge already consumed");
      const issued = await db.query<{ expires_at_ms: string }>(
        `INSERT INTO solana_sessions VALUES($1,$2,$3,now()+interval '30 days')
        RETURNING (extract(epoch from expires_at)*1000)::bigint::text AS expires_at_ms`,
        [hash, domain, owner],
      );
      return Number(issued.rows[0]!.expires_at_ms);
    },
    async evidence(domain: string, hash: string) {
      return (
        await db.query("SELECT envelope FROM solana_evidence WHERE domain=$1 AND hash=$2", [
          domain,
          hash,
        ])
      ).rows[0]?.envelope;
    },
    async evidenceActions(domain: string, hash: string) {
      return (
        await db.query(
          "SELECT kind,payload FROM solana_evidence_actions WHERE domain=$1 AND packet_hash=$2 ORDER BY created_at,id",
          [domain, hash],
        )
      ).rows;
    },
    async audit(domain: string, hash: string, kind: string, actor: string, payload: unknown) {
      await db.query(
        "INSERT INTO solana_evidence_actions(id,domain,packet_hash,kind,actor,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
        [crypto.randomUUID(), domain, hash, kind, actor, JSON.stringify(payload)],
      );
    },
    async putAttachment(domain: string, hash: string, content: Buffer) {
      await db.query("INSERT INTO solana_attachments VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [
        domain,
        hash,
        content,
      ]);
    },
    async attachment(domain: string, hash: string): Promise<Buffer | undefined> {
      return (
        await db.query("SELECT content FROM solana_attachments WHERE domain=$1 AND hash=$2", [
          domain,
          hash,
        ])
      ).rows[0]?.content;
    },
    async evidenceForMarket(domain: string, market: string) {
      return (
        await db.query<{ hash: string }>(
          "SELECT hash FROM solana_evidence WHERE domain=$1 AND envelope->'packet'->'localMarket'->>'marketId'=$2",
          [domain, market],
        )
      ).rows;
    },
    async putEvidence(domain: string, hash: string, envelope: unknown) {
      await db.query(
        "INSERT INTO solana_evidence(domain,hash,envelope) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING",
        [domain, hash, JSON.stringify(envelope)],
      );
    },
    async evidenceList(domain: string) {
      return (
        await db.query<{ hash: string }>(
          "SELECT hash FROM solana_evidence WHERE domain=$1 ORDER BY created_at DESC LIMIT 1000",
          [domain],
        )
      ).rows;
    },
    async auditHistory(domain: string) {
      return (
        await db.query(
          "SELECT * FROM solana_evidence_actions WHERE domain=$1 ORDER BY created_at DESC,id DESC LIMIT 1000",
          [domain],
        )
      ).rows;
    },
    async attachmentEvidence(domain: string, hash: string) {
      return (
        await db.query<{ hash: string }>(
          "SELECT hash FROM solana_evidence WHERE domain=$1 AND envelope->'packet'->'attachments' @> $2::jsonb",
          [domain, JSON.stringify([{ contentHash: hash }])],
        )
      ).rows;
    },
  };
}
export type SolanaQueries = ReturnType<typeof solanaQueries>;

export async function writeSnapshot(tx: PoolClient, domain: string, s: SnapshotWrite) {
  const prior = (
    await tx.query(
      "SELECT slot,accounts->'rawAccounts' AS raw FROM solana_snapshots WHERE domain=$1 FOR UPDATE",
      [domain],
    )
  ).rows[0];
  if (prior && BigInt(prior.slot) > BigInt(s.slot)) return false;
  // Same account image: only advance the snapshot watermark, avoiding rewrites of
  // every credit on quiet slots. Normalized row slots identify last projection.
  if (!prior || JSON.stringify(prior.raw) !== JSON.stringify(s.accounts.rawAccounts)) {
    await tx.query("DELETE FROM solana_asset_credits WHERE domain=$1", [domain]);
    await tx.query("DELETE FROM solana_asset_pools WHERE domain=$1", [domain]);
    await tx.query("DELETE FROM solana_market_claims WHERE domain=$1", [domain]);
    await tx.query(
      `INSERT INTO solana_asset_pools SELECT $1,x.address,x.mint,x.token_program,x.decimals,x.liability,$3
      FROM jsonb_to_recordset($2::jsonb) AS x(address text,mint text,token_program text,decimals integer,liability numeric)`,
      [domain, JSON.stringify(s.pools), s.slot],
    );
    await tx.query(
      `INSERT INTO solana_asset_credits SELECT $1,x.address,x.pool,x.owner,x.available,$3
      FROM jsonb_to_recordset($2::jsonb) AS x(address text,pool text,owner text,available numeric)`,
      [domain, JSON.stringify(s.credits), s.slot],
    );
    await tx.query(
      `INSERT INTO solana_market_claims SELECT $1,x.market,x.owner,x.mint,x.asset,x.available,$3
      FROM jsonb_to_recordset($2::jsonb) AS x(market text,owner text,mint text,asset integer,available numeric)`,
      [domain, JSON.stringify(s.claims), s.slot],
    );
  }
  await tx.query(
    `INSERT INTO solana_snapshots VALUES($1,$2,to_timestamp($4::double precision/1000),$3::jsonb)
    ON CONFLICT(domain) DO UPDATE SET slot=EXCLUDED.slot,observed_at=EXCLUDED.observed_at,accounts=EXCLUDED.accounts`,
    [domain, s.slot, JSON.stringify(s.accounts), s.observedAt],
  );
  return true;
}
