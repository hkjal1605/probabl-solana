import { Buffer } from "buffer";
import { type ConfirmedSignatureInfo, type VersionedTransactionResponse } from "@solana/web3.js";
import type { SolanaDatabase } from "@conditional-stocks/db/solana";
import { SolanaClient, coder, BN, PublicKey } from "@conditional-stocks/solana-client";
import type { Snapshot } from "./projection";

export interface HistoricalEvent {
  name: string;
  index: number;
  market: string | null;
  data: Record<string, unknown>;
}
/** Timestamp metadata is derived only from finalized on-chain creation events. */
export function creationTimes(rows: { market: string; block_time: string }[]) {
  const times = new Map<string, string>();
  for (const row of rows) {
    if (!/^\d+$/.test(row.block_time)) continue;
    const seconds = Number(row.block_time);
    if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 253402300799) continue;
    times.set(row.market, new Date(seconds * 1000).toISOString());
  }
  return times;
}
function jsonValue(value: unknown): unknown {
  if (BN.isBN(value)) return value.toString();
  if (value instanceof PublicKey) return value.toBase58();
  if (value instanceof Uint8Array) return Array.from(value);
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
    const global = [
      "PoolChange",
      "DelegateApproved",
      "DelegateRevoked",
      "DelegatesRevoked",
    ].includes(event.name);
    if (!global && typeof data.market !== "string") throw new Error("Protocol event has no market");
    events.push({
      name: event.name,
      index,
      market:
        typeof data.market === "string" && data.market !== PublicKey.default.toBase58()
          ? data.market
          : null,
      data,
    });
  }
  return { initialized, events };
}

/** Program-address history includes every instruction (pool transfers and
 * cancellations need not reference config). Isolate deployments using canonical
 * immutable account identities from the same complete program snapshot. */
export function eventInDeployment(
  event: HistoricalEvent,
  client: Pick<SolanaClient, "config">,
  s: Snapshot,
) {
  if (event.name === "PoolChange") return s.pools.has(String(event.data.pool));
  if (event.name === "DelegateRevoked")
    return s.delegations?.has(String(event.data.delegation)) ?? false;
  if (event.name === "DelegateApproved" || event.name === "DelegatesRevoked")
    return event.data.config === client.config.toBase58();
  return event.market !== null && s.markets.has(event.market);
}

/** Finalized-only replay, paginated to a verified checkpoint (or the deployment's
 * initialization). Events and checkpoint commit together. An archival RPC is
 * required after its history ages out; we never silently skip unavailable data. */
export async function replayHistory(
  db: SolanaDatabase,
  client: SolanaClient,
  domain: string,
  snapshotSlot: number,
  deployment: Snapshot,
) {
  return db.locked("history:" + domain, async (tx) => {
    const cursor = await tx.historyCursor(domain);
    if (cursor && BigInt(cursor.snapshot_slot) > BigInt(snapshotSlot)) {
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
        client.program,
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
        if (!eventInDeployment(event, client, deployment)) continue;
        if (response.blockTime === null)
          throw new Error("Transaction timestamp unavailable: " + row.signature);
        await tx.putEvent(domain, {
          signature: row.signature,
          event_index: event.index,
          slot: row.slot,
          block_time: response.blockTime!,
          name: event.name,
          market: event.market,
          data: event.data,
        });
      }
    }
    if (!initialized)
      throw new Error(
        "Cannot prove complete history: deployment initialization is missing from the RPC",
      );
    const latest = signatures[0] ?? cursor;
    if (!latest) throw new Error("Deployment has no finalized history");
    await tx.putHistoryCursor(domain, {
      signature: latest.signature,
      slot: String(latest.slot),
      snapshot_slot: String(snapshotSlot),
    });
  });
}
