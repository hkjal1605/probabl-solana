/** Live chain index: an RPC finalized bootstrap followed by a Yellowstone gRPC
 * (Geyser) stream. Serves two consistent views:
 *  - confirmed: trading reads (markets, books, order planning) about one block
 *    after a transaction lands;
 *  - finalized: custody-grade reads (balances, reconciliation, persistence).
 * Both are immutable `Snapshot`s replaced per committed slot. */
import { PublicKey, type AccountInfo, type VersionedTransactionResponse } from "@solana/web3.js";
import {
  legAccounts,
  legStates,
  type LiveLeg,
  type MarketAccount,
  type SolanaClient,
} from "@conditional-stocks/solana-client";
import type { Snapshot } from "../projection.ts";
import { AccountStore, type AccountVersion, type Commitment, type CommitResult } from "./accounts.ts";
import { ProgramView } from "./decode.ts";
import {
  type ChainEvent,
  GeyserSource,
  type GeyserClientFactory,
  type ReplayUnavailable,
} from "./geyser.ts";

export { AccountStore } from "./accounts.ts";
export { ProgramView, decodeProgramAccount } from "./decode.ts";
export { GeyserSource, normalize, subscribeRequest, transactionResponse, ReplayUnavailable } from "./geyser.ts";
export type { ChainEvent, GeyserClient, GeyserClientFactory, GeyserClientOptions, GeyserStream } from "./geyser.ts";
export { ChainRelay, relayClientFactory } from "./relay.ts";

export interface IndexedTransaction {
  signature: string;
  slot: number;
  /** Unix seconds, when the block's metadata was streamed. */
  blockTime: number | null;
  response: VersionedTransactionResponse;
}
export interface CommitNotice {
  commitment: Commitment;
  slot: number;
  snapshot: Snapshot;
  previous: Snapshot;
  /** Program and tracked addresses whose value changed. */
  changed: Set<string>;
  rebuilt: boolean;
  /** Transactions of the committed slots (confirmed: newly confirmed; finalized: newly finalized). */
  transactions: IndexedTransaction[];
}

export interface LiveIndexOptions {
  client: Pick<SolanaClient, "connection" | "program" | "config">;
  geyser: GeyserClientFactory;
  onCommit?(notice: CommitNotice): void;
  /** A replay gap forced a fresh bootstrap at `slot`. */
  onResync?(slot: number): void;
  onError?(error: unknown): void;
  /** Maximum stream silence before the index reports unhealthy. */
  staleMs?: number;
  source?: { backoffMs?: number; maxBackoffMs?: number; compression?: boolean };
  /** Every event handled by the index, in stream order (the local relay). */
  onEvent?(event: ChainEvent): void;
}

const BATCH = 100;

export class LiveIndex {
  readonly store = new AccountStore();
  private readonly views: Record<Commitment, ProgramView>;
  private snapshots: Partial<Record<Commitment, Snapshot>> = {};
  private readonly source: GeyserSource;
  private tracked = new Set<string>();
  private readonly transactions = new Map<number, IndexedTransaction[]>();
  private readonly confirmedTransactions = new Map<number, IndexedTransaction[]>();
  private readonly blockTimes = new Map<number, number>();
  private bootstrapped = false;
  private resyncing: Promise<void> | undefined;
  private readonly program: string;

  constructor(private readonly options: LiveIndexOptions) {
    this.program = options.client.program.toBase58();
    this.views = { confirmed: new ProgramView(options.client), finalized: new ProgramView(options.client) };
    this.source = new GeyserSource(
      options.geyser,
      { program: this.program, ...options.source },
      {
        onEvent: (event) => {
          if (this.bootstrapped) this.options.onEvent?.(event);
          this.handle(event);
        },
        // Everything up to the confirmed slot is already committed (or pending
        // finalization) here; replay only newer slots.
        resume: () => (this.bootstrapped ? this.store.confirmedSlot + 1 : undefined),
        onGap: (gap) => void this.resync(gap),
        onError: (error) => options.onError?.(error),
      },
    );
  }

  async start() {
    await this.bootstrap();
    await this.source.start();
  }

  stop() {
    this.source.stop();
  }

  confirmed(): Snapshot {
    const s = this.snapshots.confirmed;
    if (!s) throw new Error("Live index is not bootstrapped");
    return s;
  }
  finalized(): Snapshot {
    const s = this.snapshots.finalized;
    if (!s) throw new Error("Live index is not bootstrapped");
    return s;
  }

  health() {
    const age = Date.now() - this.source.lastMessageAt;
    return {
      healthy: this.bootstrapped && this.source.connected && age <= (this.options.staleMs ?? 15_000) && !this.resyncing,
      connected: this.source.connected,
      lastMessageAgeMs: age,
      confirmedSlot: this.store.confirmedSlot,
      finalizedSlot: this.store.finalizedSlot,
      backlog: this.store.backlog(),
    };
  }

  /** Program account images of a view, for durable persistence and audits. */
  rawAccounts(commitment: Commitment) {
    const rows: { address: string; data: string }[] = [];
    for (const [address, version] of this.store.entries(commitment))
      if (version.owner === this.program) rows.push({ address, data: version.data.toString("base64") });
    return rows.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  }

  /** Raw info of a streamed account in a view (issuer mints, pool vaults, program accounts). */
  accountInfo(commitment: Commitment, address: string): AccountInfo<Buffer> | null {
    const version = this.store.get(commitment, address);
    return version ? toInfo(version) : null;
  }

  private async bootstrap() {
    const { connection } = this.options.client;
    const response = await connection.getProgramAccounts(this.options.client.program, {
      commitment: "finalized",
      withContext: true,
    });
    const slot = response.context.slot;
    const entries = new Map<string, AccountVersion>();
    for (const { pubkey, account } of response.value)
      entries.set(pubkey.toBase58(), {
        slot,
        writeVersion: 0n,
        owner: this.program,
        lamports: BigInt(account.lamports),
        data: account.data,
      });
    const programEntries = [...entries].map(([address, v]) => [address, v.data] as [string, Buffer]);
    const probe = new ProgramView(this.options.client).rebuild(slot, programEntries);
    this.tracked = trackedAccounts(probe.markets.values(), this.options.client);
    for (const [address, info] of await readAccounts(connection, [...this.tracked], "finalized", slot))
      if (info)
        entries.set(address, { slot, writeVersion: 0n, owner: info.owner.toBase58(), lamports: BigInt(info.lamports), data: info.data });
    this.store.bootstrap(slot, entries);
    this.transactions.clear();
    this.confirmedTransactions.clear();
    this.blockTimes.clear();
    for (const commitment of ["confirmed", "finalized"] as const) {
      this.views[commitment].rebuild(slot, programEntries);
      this.snapshots[commitment] = this.withLegs(commitment, this.views[commitment].snapshot);
    }
    this.source.track([...this.tracked]);
    this.bootstrapped = true;
  }

  /** Re-bootstraps from RPC after a replay gap or a failed commit. */
  private async resync(cause: ReplayUnavailable | unknown) {
    if (this.resyncing) return;
    this.options.onError?.(cause);
    this.resyncing = (async () => {
      this.source.stop();
      this.bootstrapped = false;
      for (;;)
        try {
          await this.bootstrap();
          break;
        } catch (error) {
          this.options.onError?.(error);
          await Bun.sleep(1000);
        }
      this.options.onResync?.(this.store.finalizedSlot);
      await this.source.start();
    })().finally(() => (this.resyncing = undefined));
    await this.resyncing;
  }

  /** Routes one stream event. Synchronous: commits are slot-atomic. A commit
   * that fails (e.g. an account failing authentication) leaves the views
   * unusable, so the index goes unhealthy and re-bootstraps. */
  handle(event: ChainEvent) {
    if (!this.bootstrapped) return;
    try {
      this.route(event);
    } catch (error) {
      this.bootstrapped = false;
      void this.resync(error);
    }
  }

  private route(event: ChainEvent) {
    switch (event.kind) {
      case "account":
        this.store.account(event.address, event.version);
        return;
      case "transaction":
        // Replays after a reconnect resend confirmed slots' transactions.
        if (event.slot <= this.store.finalizedSlot || this.seen(event.slot, event.signature)) return;
        push(this.transactions, event.slot, {
          signature: event.signature,
          slot: event.slot,
          blockTime: null,
          response: event.response,
        });
        return;
      case "blockTime":
        if (event.slot > this.store.finalizedSlot) this.blockTimes.set(event.slot, event.blockTime);
        return;
      case "slot":
        if (event.parent !== undefined) this.store.parent(event.slot, event.parent);
        if (event.status === "confirmed") this.commit(this.store.confirm(event.slot), this.confirmTransactions(event.slot));
        else if (event.status === "finalized") {
          const { finalized, confirmed, onChain } = this.store.finalize(event.slot);
          if (confirmed) this.commit(confirmed, this.confirmTransactions(event.slot));
          this.commit(finalized, this.finalizeTransactions(event.slot, onChain));
        } else if (event.status === "dead") {
          this.transactions.delete(event.slot);
          this.confirmedTransactions.delete(event.slot);
          this.blockTimes.delete(event.slot);
          const rebuilt = this.store.dead(event.slot);
          if (rebuilt) this.commit(rebuilt, []);
        }
        return;
    }
  }

  private seen(slot: number, signature: string) {
    for (const map of [this.transactions, this.confirmedTransactions])
      if (map.get(slot)?.some((tx) => tx.signature === signature)) return true;
    return false;
  }

  private confirmTransactions(slot: number) {
    const out: IndexedTransaction[] = [];
    for (const s of [...this.transactions.keys()].filter((s) => s <= slot).sort((a, b) => a - b)) {
      const list = this.transactions.get(s)!;
      this.transactions.delete(s);
      for (const tx of list) tx.blockTime = this.blockTimes.get(s) ?? null;
      push(this.confirmedTransactions, s, ...list);
      out.push(...list);
    }
    return out;
  }

  /** Transactions of newly finalized slots; those of abandoned forks are dropped. */
  private finalizeTransactions(slot: number, onChain: (slot: number) => boolean) {
    const out: IndexedTransaction[] = [];
    for (const s of [...this.confirmedTransactions.keys()].filter((s) => s <= slot).sort((a, b) => a - b)) {
      if (onChain(s))
        for (const tx of this.confirmedTransactions.get(s)!) {
          tx.blockTime ??= this.blockTimes.get(s) ?? null;
          out.push(tx);
        }
      this.confirmedTransactions.delete(s);
    }
    for (const s of [...this.blockTimes.keys()]) if (s <= slot) this.blockTimes.delete(s);
    return out;
  }

  private commit(result: CommitResult, transactions: IndexedTransaction[]) {
    const commitment = result.commitment;
    const view = this.views[commitment];
    const previous = this.snapshots[commitment]!;
    let snapshot: Snapshot;
    let changed: Set<string>;
    let trackedChanged = false;
    if (result.rebuilt) {
      const entries: [string, Buffer][] = [];
      for (const [address, version] of this.store.entries(commitment))
        if (version.owner === this.program) entries.push([address, version.data]);
      snapshot = view.rebuild(result.slot, entries);
      changed = result.changed;
      trackedChanged = true;
      this.retrack(snapshot);
    } else {
      const programChanges: [string, Buffer | undefined][] = [];
      for (const address of result.changed) {
        if (this.tracked.has(address)) trackedChanged = true;
        const version = this.store.get(commitment, address);
        if (version && version.owner === this.program) programChanges.push([address, version.data]);
        else if (view.kindOf(address)) programChanges.push([address, undefined]); // closed
      }
      if (!programChanges.length && !trackedChanged && !transactions.length) {
        // No projection changed, but the index is current at this slot now:
        // readers judge freshness by observedAt, not by the last account change.
        this.snapshots[commitment] = {
          ...previous,
          slot: Math.max(previous.slot, result.slot),
          observedAt: Date.now(),
        };
        return;
      }
      const applied = programChanges.length
        ? view.apply(result.slot, programChanges)
        : { snapshot: { ...previous, slot: result.slot, observedAt: Date.now() }, changed: new Set<string>() };
      snapshot = applied.snapshot;
      changed = new Set([...applied.changed, ...[...result.changed].filter((a) => this.tracked.has(a))]);
      const marketsChanged = [...applied.changed].some((a) => snapshot.markets.has(a) || previous.markets.has(a));
      if (marketsChanged) this.retrack(snapshot);
      trackedChanged ||= marketsChanged;
    }
    snapshot = this.withLegs(commitment, snapshot, trackedChanged ? undefined : previous.legs);
    this.snapshots[commitment] = snapshot;
    try {
      this.options.onCommit?.({ commitment, slot: result.slot, snapshot, previous, changed, rebuilt: result.rebuilt, transactions });
    } catch (error) {
      this.options.onError?.(error); // A consumer failure never corrupts the index.
    }
  }

  /** Re-evaluates live leg state against the clock (a scheduled multiplier
   * takes effect at its timestamp without any account changing). */
  refreshLegs() {
    for (const commitment of ["confirmed", "finalized"] as const) {
      const current = this.snapshots[commitment];
      if (current) this.snapshots[commitment] = this.withLegs(commitment, current);
    }
  }

  /** Live issuer state per market from streamed mints and pool vaults. */
  private withLegs(commitment: Commitment, snapshot: Snapshot, reuse?: Snapshot["legs"]): Snapshot {
    if (reuse) return { ...snapshot, legs: reuse };
    const legs = new Map<string, Record<number, LiveLeg>>();
    for (const [id, market] of snapshot.markets) {
      const keys = legAccounts(market, this.options.client.config, this.options.client.program);
      legs.set(id, legStates(market, keys.map((k) => this.accountInfo(commitment, k.toBase58())), this.options.client.config, this.options.client.program));
    }
    return { ...snapshot, legs };
  }

  /** New markets or listed legs add issuer mints / pool vaults to the stream,
   * seeded with their current value (the stream only sends later changes). */
  private retrack(snapshot: Snapshot) {
    const next = trackedAccounts(snapshot.markets.values(), this.options.client);
    const added = [...next].filter((a) => !this.tracked.has(a));
    this.tracked = next;
    this.source.track([...next]);
    if (!added.length) return;
    void readAccounts(this.options.client.connection, added, "confirmed").then(
      (rows) => {
        for (const [address, info] of rows)
          if (info)
            this.store.seed(address, {
              slot: this.store.confirmedSlot,
              writeVersion: 0n,
              owner: info.owner.toBase58(),
              lamports: BigInt(info.lamports),
              data: info.data,
            });
        for (const commitment of ["confirmed", "finalized"] as const)
          this.snapshots[commitment] = this.withLegs(commitment, this.snapshots[commitment]!);
      },
      (error) => this.options.onError?.(error),
    );
  }
}

function push<T>(map: Map<number, T[]>, slot: number, ...values: T[]) {
  const list = map.get(slot);
  if (list) list.push(...values);
  else map.set(slot, [...values]);
}

const toInfo = (version: AccountVersion): AccountInfo<Buffer> => ({
  data: version.data,
  owner: new PublicKey(version.owner),
  lamports: Number(version.lamports),
  executable: false,
});

/** Issuer mints and pool vaults of every listed leg (shared across markets). */
export function trackedAccounts(markets: Iterable<MarketAccount>, client: Pick<SolanaClient, "config" | "program">) {
  const out = new Set<string>();
  for (const market of markets) for (const key of legAccounts(market, client.config, client.program)) out.add(key.toBase58());
  return out;
}

async function readAccounts(
  connection: SolanaClient["connection"],
  addresses: string[],
  commitment: "confirmed" | "finalized",
  minContextSlot?: number,
) {
  const out: [string, AccountInfo<Buffer> | null][] = [];
  for (let i = 0; i < addresses.length; i += BATCH) {
    const chunk = addresses.slice(i, i + BATCH);
    const values = await connection.getMultipleAccountsInfo(
      chunk.map((a) => new PublicKey(a)),
      { commitment, ...(minContextSlot !== undefined ? { minContextSlot } : {}) },
    );
    if (values.length !== chunk.length) throw new Error("Incomplete account read");
    chunk.forEach((address, j) => out.push([address, values[j] ?? null]));
  }
  return out;
}
