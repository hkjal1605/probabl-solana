import { Buffer } from "buffer";
import { type ConfirmedSignatureInfo, type VersionedTransactionResponse } from "@solana/web3.js";
import { type Pool } from "pg";
import { SolanaClient, coder, BN, PublicKey } from "@conditional-stocks/solana-client";

export interface HistoricalEvent {
  name: string;
  index: number;
  market: string;
  data: Record<string, unknown>;
}
function jsonValue(value: unknown): unknown {
  if (BN.isBN(value)) return value.toString();
  if (value instanceof PublicKey) return value.toBase58();
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonValue(v)]));
  return value;
}
/** Only successful transactions and events attributed to our program's invocation
 * stack are usable. Missing/truncated logs are a gap, never an empty history. */
export function decodeHistory(
  client: Pick<SolanaClient, "program" | "config">,
  tx: VersionedTransactionResponse,
) {
  if (!tx.meta) throw new Error("Transaction metadata is missing");
  if (tx.meta.err) return { initialized: false, events: [] as HistoricalEvent[] };
  const logs = tx.meta.logMessages;
  if (!logs || logs.some((line) => /^Log truncated(?:\b|$)/i.test(line)))
    throw new Error("Transaction event logs are unavailable or truncated");
  const keys = tx.transaction.message.getAccountKeys({
    accountKeysFromLookups: tx.meta.loadedAddresses ?? null,
  });
  let ownInstructions = 0;
  const initializationInstructions = tx.transaction.message.compiledInstructions.map((ix) => {
    if (!keys.get(ix.programIdIndex)?.equals(client.program)) return false;
    ownInstructions++;
    const decoded = coder.instruction.decode(Buffer.from(ix.data));
    return (
      decoded?.name === "initialize" && keys.get(ix.accountKeyIndexes[1]!)?.equals(client.config)
    );
  });
  const initialized = initializationInstructions.some(Boolean);
  const events: HistoricalEvent[] = [];
  // A successful transaction can contain a failed CPI whose error its caller
  // caught. Runtime rollback removes that CPI's state changes, NOT its logs.
  // Stage events per invocation, committing only when every ancestor succeeds.
  const stack: { program: string; events: string[] }[] = [],
    committed: string[] = [];
  let ownRoots = 0;
  for (const line of logs) {
    const invocation = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/.exec(line);
    if (invocation) {
      if (Number(invocation[2]) !== stack.length + 1) throw new Error("Incomplete invocation logs");
      if (!stack.length && invocation[1] === client.program.toBase58()) ownRoots++;
      stack.push({ program: invocation[1]!, events: [] });
      continue;
    }
    const completion = /^Program ([1-9A-HJ-NP-Za-km-z]+) (success|failed:.*)$/.exec(line);
    if (completion) {
      const frame = stack.pop();
      if (!frame || frame.program !== completion[1]) throw new Error("Mismatched invocation logs");
      if (completion[2] === "success") (stack.at(-1)?.events ?? committed).push(...frame.events);
      continue;
    }
    if (line.startsWith("Program data: ") && stack.at(-1)?.program === client.program.toBase58())
      stack.at(-1)!.events.push(line.slice("Program data: ".length));
  }
  if (stack.length || ownRoots < ownInstructions)
    throw new Error("Incomplete program invocation logs");
  for (const [index, encoded] of committed.entries()) {
    const event = coder.events.decode(encoded);
    if (!event) throw new Error("Unknown native event schema");
    const data = jsonValue(event.data) as Record<string, unknown>;
    if (typeof data.market !== "string") throw new Error("Protocol event has no market");
    events.push({ name: event.name, index, market: data.market, data });
  }
  return { initialized, events };
}

export async function initializeHistory(db: Pool) {
  await db.query(`CREATE TABLE IF NOT EXISTS solana_history_cursors (
    domain text PRIMARY KEY, signature text NOT NULL, slot bigint NOT NULL, snapshot_slot bigint NOT NULL)`);
  await db.query(`CREATE TABLE IF NOT EXISTS solana_events (
    domain text NOT NULL, signature text NOT NULL, event_index integer NOT NULL,
    slot bigint NOT NULL, block_time bigint NOT NULL, name text NOT NULL, market text NOT NULL, data jsonb NOT NULL,
    PRIMARY KEY(domain, signature, event_index))`);
  await db.query(
    `CREATE INDEX IF NOT EXISTS solana_events_market ON solana_events(domain, market, slot DESC)`,
  );
}

/** Finalized-only replay, paginated to a verified checkpoint (or the deployment's
 * initialization). Events and checkpoint commit together. An archival RPC is
 * required after its history ages out; we never silently skip unavailable data. */
export async function replayHistory(
  db: Pool,
  client: SolanaClient,
  domain: string,
  snapshotSlot: number,
) {
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["history:" + domain]);
    const saved = await tx.query<{ signature: string; slot: string; snapshot_slot: string }>(
      "SELECT * FROM solana_history_cursors WHERE domain=$1",
      [domain],
    );
    const cursor = saved.rows[0];
    if (cursor && BigInt(cursor.snapshot_slot) > BigInt(snapshotSlot)) {
      await tx.query("COMMIT");
      return;
    }
    if (
      cursor &&
      BigInt(await client.connection.getFirstAvailableBlock()) > BigInt(cursor.snapshot_slot) + 1n
    )
      throw new Error(
        "RPC retention has overtaken the last fully scanned slot; archival recovery is required",
      );
    const signatures: ConfirmedSignatureInfo[] = [];
    let before: string | undefined,
      reached = false;
    while (!reached) {
      const page = await client.connection.getSignaturesForAddress(
        client.config,
        { ...(before ? { before } : {}), limit: 1000 },
        "finalized",
      );
      if (!page.length) break;
      for (const row of page) {
        // A quiet deployment's last signature may age out despite continuously
        // scanning every finalized slot. The scanned SLOT, not that old signature,
        // establishes completeness. Replay the boundary slot idempotently.
        if (cursor && BigInt(row.slot) < BigInt(cursor.snapshot_slot)) {
          reached = true;
          break;
        }
        if (row.slot <= snapshotSlot) signatures.push(row);
      }
      before = page.at(-1)!.signature;
      if (signatures.length > 100_000)
        throw new Error(
          "History catch-up exceeds the safe batch limit; configure an archival backfill",
        );
    }
    let initialized = Boolean(cursor);
    // RPC address ordering is retained; idempotent keys make same-slot replay safe.
    for (const row of [...signatures].reverse()) {
      if (row.err) continue;
      const response = await client.connection.getTransaction(row.signature, {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      });
      if (!response || response.slot !== row.slot)
        throw new Error("Finalized transaction is unavailable: " + row.signature);
      const decoded = decodeHistory(client, response);
      initialized ||= decoded.initialized;
      for (const event of decoded.events) {
        if (response.blockTime === null)
          throw new Error("Transaction timestamp unavailable: " + row.signature);
        await tx.query(
          `INSERT INTO solana_events VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT DO NOTHING`,
          [
            domain,
            row.signature,
            event.index,
            row.slot,
            response.blockTime,
            event.name,
            event.market,
            JSON.stringify(event.data),
          ],
        );
      }
    }
    if (!initialized)
      throw new Error(
        "Cannot prove complete history: deployment initialization is missing from the RPC",
      );
    const latest = signatures[0] ?? cursor;
    if (!latest) throw new Error("Deployment has no finalized history");
    await tx.query(
      `INSERT INTO solana_history_cursors VALUES($1,$2,$3,$4)
      ON CONFLICT(domain) DO UPDATE SET signature=EXCLUDED.signature,slot=EXCLUDED.slot,snapshot_slot=EXCLUDED.snapshot_slot`,
      [domain, latest.signature, latest.slot, snapshotSlot],
    );
    await tx.query("COMMIT");
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
