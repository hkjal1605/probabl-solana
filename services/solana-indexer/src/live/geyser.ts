/** Yellowstone gRPC (Geyser) datasource: one confirmed-commitment subscription
 * carrying every program account (owner filter), a small explicit set of
 * issuer mints and pool vaults, program transactions, block times and every
 * slot status. Reconnects resume from the last finalized slot (`from_slot`),
 * which the store deduplicates by (slot, write_version); when the server can
 * no longer replay that far the caller is told to resynchronize. */
import { EventEmitter } from "node:events";
import bs58 from "bs58";
import { MessageAccountKeys, PublicKey, type VersionedTransactionResponse } from "@solana/web3.js";
import type { AccountVersion } from "./accounts.ts";

export type SlotStatus = "processed" | "confirmed" | "finalized" | "dead";
export type ChainEvent =
  | { kind: "account"; address: string; version: AccountVersion }
  | { kind: "slot"; slot: number; parent?: number; status: SlotStatus }
  | { kind: "transaction"; slot: number; signature: string; response: VersionedTransactionResponse }
  | { kind: "blockTime"; slot: number; blockTime: number };

/** The subset of the Yellowstone client this source uses (injectable in tests). */
export interface GeyserStream extends EventEmitter {
  write(request: unknown, callback?: (error?: Error | null) => void): boolean;
  end(): void;
  destroy?(error?: Error): void;
}
export interface GeyserClient {
  connect(): Promise<void>;
  subscribe(): Promise<GeyserStream>;
  subscribeReplayInfo(): Promise<{ firstAvailable?: string | undefined }>;
}
export interface GeyserClientOptions {
  /** Ask the server to zstd-compress updates (about 40% fewer billed bytes). */
  compression: boolean;
}
export type GeyserClientFactory = (options: GeyserClientOptions) => GeyserClient;

export interface SourceOptions {
  program: string;
  /** Minimum ms between reconnect attempts, doubling to `maxBackoffMs`. */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** Request compressed updates (default). Falls back automatically when
   * the endpoint rejects compressed requests. */
  compression?: boolean;
}

/** An endpoint that does not support the requested gRPC compression. */
export const compressionRejected = (error: unknown) =>
  /compress|zstd|gzip|encoding/i.test(`${error instanceof Error ? error.message : String(error)} ${String((error as { cause?: unknown })?.cause ?? "")}`);

const STATUS: Record<number, SlotStatus | undefined> = { 0: "processed", 1: "confirmed", 2: "finalized", 6: "dead" };
const CONFIRMED = 1;
const b58 = (bytes: Uint8Array) => new PublicKey(bytes).toBase58();

/** Web3.js-shaped view of a Geyser transaction, enough for `decodeHistory`. */
export function transactionResponse(info: {
  transaction?: { message?: { accountKeys: Uint8Array[]; instructions: { programIdIndex: number; accounts: Uint8Array; data: Uint8Array }[] } };
  meta?: { err?: unknown; logMessages: string[]; logMessagesNone: boolean; loadedWritableAddresses: Uint8Array[]; loadedReadonlyAddresses: Uint8Array[] };
}, slot: number): VersionedTransactionResponse {
  const message = info.transaction?.message;
  const meta = info.meta;
  if (!message || !meta) throw new Error("Geyser transaction is missing its message or status");
  const staticKeys = message.accountKeys.map((k) => new PublicKey(k));
  const loadedAddresses = {
    writable: meta.loadedWritableAddresses.map((k) => new PublicKey(k)),
    readonly: meta.loadedReadonlyAddresses.map((k) => new PublicKey(k)),
  };
  const compiledInstructions = message.instructions.map((ix) => ({
    programIdIndex: ix.programIdIndex,
    accountKeyIndexes: [...ix.accounts],
    data: ix.data,
  }));
  return {
    slot,
    blockTime: null,
    meta: {
      err: meta.err ?? null,
      logMessages: meta.logMessagesNone ? null : meta.logMessages,
      loadedAddresses,
    },
    transaction: {
      message: {
        compiledInstructions,
        getAccountKeys: () => new MessageAccountKeys(staticKeys, loadedAddresses),
      },
      signatures: [],
    },
  } as unknown as VersionedTransactionResponse;
}

/** Normalizes one SubscribeUpdate into chain events. Relay streams carry
 * already-normalized events. */
export function normalize(update: Record<string, any>): ChainEvent | undefined {
  if (update.chainEvent) return update.chainEvent as ChainEvent;
  if (update.account?.account) {
    const a = update.account.account;
    return {
      kind: "account",
      address: b58(a.pubkey),
      version: {
        slot: Number(update.account.slot),
        writeVersion: BigInt(a.writeVersion),
        owner: b58(a.owner),
        lamports: BigInt(a.lamports),
        data: Buffer.from(a.data),
      },
    };
  }
  if (update.slot) {
    const status = STATUS[update.slot.status];
    if (!status) return undefined;
    return {
      kind: "slot",
      slot: Number(update.slot.slot),
      status,
      ...(update.slot.parent !== undefined ? { parent: Number(update.slot.parent) } : {}),
    };
  }
  if (update.transaction?.transaction) {
    const slot = Number(update.transaction.slot);
    return {
      kind: "transaction",
      slot,
      signature: bs58.encode(update.transaction.transaction.signature),
      response: transactionResponse(update.transaction.transaction, slot),
    };
  }
  if (update.blockMeta?.blockTime) {
    return { kind: "blockTime", slot: Number(update.blockMeta.slot), blockTime: Number(update.blockMeta.blockTime.timestamp) };
  }
  return undefined;
}

/** The reply to a server keep-alive ping. Yellowstone treats any request
 * carrying `ping` as a pong and leaves the subscription's filters untouched;
 * the client encoder still needs every request map present. */
export function pingRequest(id: number) {
  return {
    accounts: {},
    slots: {},
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
    ping: { id },
  };
}

export function subscribeRequest(program: string, accounts: readonly string[], fromSlot?: number) {
  return {
    accounts: {
      program: { account: [], owner: [program], filters: [] },
      ...(accounts.length ? { tracked: { account: [...accounts], owner: [], filters: [] } } : {}),
    },
    slots: { slots: { filterByCommitment: false, interslotUpdates: false } },
    transactions: {
      program: { vote: false, failed: false, accountInclude: [program], accountExclude: [], accountRequired: [] },
    },
    transactionsStatus: {},
    blocks: {},
    blocksMeta: { times: {} },
    entry: {},
    accountsDataSlice: [],
    commitment: CONFIRMED,
    ...(fromSlot !== undefined ? { fromSlot: String(fromSlot) } : {}),
  };
}

/** Replay availability. Yellowstone reports u64::MAX until its replay store
 * first trims (retention not yet reached): everything since the plugin started
 * is then still stored. Undefined means replay is disabled on the server. */
export function replayable(firstAvailable: string | undefined, fromSlot: number) {
  if (firstAvailable === undefined) return false;
  const first = BigInt(firstAvailable);
  return first === (1n << 64n) - 1n || first <= BigInt(fromSlot);
}

export class ReplayUnavailable extends Error {
  constructor(readonly fromSlot: number, readonly firstAvailable: number | undefined) {
    super(`Geyser cannot replay from slot ${fromSlot} (first available ${firstAvailable ?? "unknown"})`);
  }
}

/** A resilient subscription. `resume()` supplies the slot to replay from on
 * each (re)connect; `onEvent` receives normalized events in stream order. */
export class GeyserSource {
  private stream: GeyserStream | undefined;
  private accounts: string[] = [];
  private stopped = false;
  private pongs = 0;
  private attempt = 0;
  private compression: boolean;
  /** Bumped by stop(): stale reconnect timers and in-flight connects exit. */
  private generation = 0;
  lastMessageAt = 0;
  connected = false;

  constructor(
    private readonly factory: GeyserClientFactory,
    private readonly options: SourceOptions,
    private readonly handlers: {
      onEvent(event: ChainEvent): void;
      /** Returns the slot to replay from, or undefined for a live start. */
      resume(): number | undefined;
      /** Replay is impossible: the consumer must resynchronize from RPC. */
      onGap(error: ReplayUnavailable): void;
      onError?(error: unknown): void;
    },
  ) {
    this.compression = options.compression ?? true;
  }

  /** Replaces the explicitly tracked (non-program) accounts on the live stream. */
  track(accounts: readonly string[]) {
    const next = [...new Set(accounts)].sort();
    if (next.join() === this.accounts.join()) return;
    this.accounts = next;
    this.stream?.write(subscribeRequest(this.options.program, this.accounts));
  }

  async start() {
    this.stopped = false;
    await this.connect();
  }

  stop() {
    this.stopped = true;
    this.generation++;
    this.stream?.end();
    this.stream = undefined;
    this.connected = false;
  }

  private async connect(): Promise<void> {
    const generation = this.generation;
    const current = () => !this.stopped && generation === this.generation;
    if (!current()) return;
    const client = this.factory({ compression: this.compression });
    let stream: GeyserStream | undefined;
    try {
      await client.connect();
      const fromSlot = this.handlers.resume();
      if (fromSlot !== undefined) {
        const info = await client.subscribeReplayInfo();
        if (!current()) return;
        if (!replayable(info.firstAvailable, fromSlot)) {
          this.handlers.onGap(
            new ReplayUnavailable(fromSlot, info.firstAvailable === undefined ? undefined : Number(info.firstAvailable)),
          );
          return;
        }
      }
      const opened = (stream = await client.subscribe());
      if (!current()) {
        opened.end();
        return;
      }
      this.stream = opened;
      opened.on("data", (update: Record<string, any>) => {
        if (this.stream !== opened) return;
        this.lastMessageAt = Date.now();
        this.attempt = 0;
        // Answer the server's keep-alive (every ~10 s) instead of sending our own.
        if (update.ping) opened.write(pingRequest(++this.pongs));
        let event: ChainEvent | undefined;
        try {
          event = normalize(update);
        } catch (error) {
          this.handlers.onError?.(error);
          return;
        }
        if (event) this.handlers.onEvent(event);
      });
      const retry = (error?: unknown) => {
        if (this.stream !== opened) return;
        this.stream = undefined;
        this.connected = false;
        if (error) this.failed(error);
        this.scheduleReconnect();
      };
      opened.on("error", retry);
      opened.on("end", () => retry());
      opened.on("close", () => retry());
      await new Promise<void>((resolve, reject) =>
        opened.write(subscribeRequest(this.options.program, this.accounts, fromSlot), (error) => (error ? reject(error) : resolve())),
      );
      this.connected = true;
      this.lastMessageAt = Date.now();
    } catch (error) {
      if (stream && this.stream === stream) this.stream = undefined;
      stream?.end();
      if (!current()) return;
      this.failed(error);
      this.scheduleReconnect();
    }
  }

  private failed(error: unknown) {
    this.handlers.onError?.(error);
    if (this.compression && compressionRejected(error)) {
      this.compression = false;
      this.attempt = 0;
      this.handlers.onError?.(new Error("Geyser endpoint rejected compression; streaming uncompressed"));
    }
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    const generation = this.generation;
    const delay = Math.min(this.options.maxBackoffMs ?? 5_000, (this.options.backoffMs ?? 250) * 2 ** this.attempt++);
    setTimeout(() => {
      if (generation === this.generation) void this.connect();
    }, delay);
  }
}
