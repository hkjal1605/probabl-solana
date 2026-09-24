/** Keeps every market's static accounts and every resting maker's PDAs in
 * append-only address lookup tables, so a placement references them with
 * one-byte indexes and all MAX_MAKERS makers fit one 1232-byte transaction.
 * Without it only ~1 maker fits (5 with a static deployment table).
 *
 * Entries are only ever appended; tables are never deactivated here, so an
 * index a client compiled against stays valid. Only owners of live orders are
 * added: resting an order reserves real collateral, which bounds how cheaply
 * anyone can make the keeper spend rent. A daily address budget caps it too. */
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  type Connection,
  type Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  deploymentLookupAddresses,
  type KeptTable,
  marketLookupAddresses,
  participantLookupAddresses,
  planLookupExtensions,
  type SolanaClient,
} from "@conditional-stocks/solana-client";
import { liveOrder, type Snapshot } from "./projection.ts";

export interface LookupRegistry {
  lookupTables(domain: string): Promise<string[]>;
  putLookupTable(domain: string, address: string, authority: string, slot: number): Promise<void>;
}

/** A pre-registered market maker: its own PDAs plus the delegation grants of
 * any keys it quotes through. */
export interface RegisteredOwner {
  owner: PublicKey;
  delegates: readonly PublicKey[];
}

/** `owner[:delegate...]` entries separated by commas or whitespace. */
export function parseRegisteredOwners(spec: string | undefined): RegisteredOwner[] {
  const seen = new Set<string>();
  const out: RegisteredOwner[] = [];
  for (const entry of (spec ?? "").split(/[\s,]+/).filter(Boolean)) {
    const [owner, ...delegates] = entry.split(":").map((key) => new PublicKey(key));
    if (seen.has(owner!.toBase58())) throw new Error("Duplicate registered owner: " + owner!.toBase58());
    seen.add(owner!.toBase58());
    out.push({ owner: owner!, delegates });
  }
  return out;
}

/** Everything a placement may reference, most valuable first: program-wide
 * accounts, each market's static accounts, then pre-registered owners (e.g.
 * professional market makers, so their very first quote is already table-
 * resident), then per market the participants of live orders (owners,
 * recipients, delegation grants). */
export function desiredLookupAddresses(
  s: Snapshot,
  client: Pick<SolanaClient, "config" | "program">,
  now?: bigint,
  registered: readonly RegisteredOwner[] = [],
) {
  const addresses = deploymentLookupAddresses(client.config, client.program);
  const participants = new Map<string, { market: PublicKey; owner: PublicKey; delegates: Map<string, PublicKey> }>();
  const markets = [...s.markets].sort(([a], [b]) => a.localeCompare(b));
  for (const [id, market] of markets)
    addresses.push(...marketLookupAddresses(client.config, new PublicKey(id), market, client.program));
  for (const [id, market] of markets)
    for (const { owner, delegates } of registered)
      addresses.push(...participantLookupAddresses(client.config, new PublicKey(id), market, owner, delegates, client.program));
  const orders = [...s.orders.values()]
    .filter((o) => liveOrder(o, s, now))
    .sort((a, b) => (a.sequence.lt(b.sequence) ? -1 : a.sequence.gt(b.sequence) ? 1 : 0));
  for (const o of orders)
    for (const owner of [o.owner, o.terms.recipient]) {
      const entryKey = `${o.market.toBase58()}:${owner.toBase58()}`;
      const entry = participants.get(entryKey) ?? { market: o.market, owner, delegates: new Map() };
      if (owner.equals(o.owner) && !o.delegate.equals(PublicKey.default))
        entry.delegates.set(o.delegate.toBase58(), o.delegate);
      participants.set(entryKey, entry);
    }
  for (const { market, owner, delegates } of participants.values()) {
    const account = s.markets.get(market.toBase58());
    if (account)
      addresses.push(
        ...participantLookupAddresses(client.config, market, account, owner, [...delegates.values()], client.program),
      );
  }
  return addresses;
}

export class LookupKeeper {
  private spentDay = "";
  private spent = 0;
  private running = false;
  /** Addresses present in our active tables as of the last read, and when.
   * A pass whose desired addresses are all known does no RPC or database
   * I/O; any write invalidates it, and it is re-read at least every
   * `refreshMs` (another process could deactivate a table). */
  private known: { addresses: Set<string>; at: number } | undefined;
  constructor(
    private readonly connection: Connection,
    private readonly client: Pick<SolanaClient, "config" | "program">,
    private readonly registry: LookupRegistry,
    private readonly domain: string,
    private readonly authority: Keypair,
    private readonly options: {
      dailyAddressBudget?: number;
      maxTransactionsPerSync?: number;
      /** Maximum age of the cached table contents (default 60 s). */
      refreshMs?: number;
      /** Owners pre-registered in every market (market makers), as
       * `owner[:delegate...]`. Exempt from the live-order requirement, not
       * from the daily budget. */
      owners?: string | undefined;
    } = {},
  ) {
    this.registered = parseRegisteredOwners(options.owners);
  }
  private readonly registered: RegisteredOwner[];

  async tables(): Promise<KeptTable[]> {
    const addresses = await this.registry.lookupTables(this.domain);
    if (!addresses.length) return [];
    // `confirmed`: extensions sent by the previous sync are already visible, so
    // they are not appended twice. Clients use `finalized` entries only.
    const infos = await this.connection.getMultipleAccountsInfo(addresses.map((a) => new PublicKey(a)), "confirmed");
    return infos.flatMap((info, index) => {
      if (!info || !info.owner.equals(AddressLookupTableProgram.programId)) return [];
      const state = AddressLookupTableAccount.deserialize(info.data);
      const table = new AddressLookupTableAccount({ key: new PublicKey(addresses[index]!), state });
      if (!state.authority?.equals(this.authority.publicKey)) return [];
      return [{ key: table.key, addresses: state.addresses, active: table.isActive() }];
    });
  }

  /** One bounded, non-overlapping pass. Returns the actions it took. */
  async sync(s: Snapshot) {
    if (this.running) return { extended: 0, created: 0, skipped: true as const };
    this.running = true;
    try {
      const day = new Date().toISOString().slice(0, 10);
      if (day !== this.spentDay) {
        this.spentDay = day;
        this.spent = 0;
      }
      const budget = (this.options.dailyAddressBudget ?? 20_000) - this.spent;
      let transactions = this.options.maxTransactionsPerSync ?? 12;
      const desired = desiredLookupAddresses(s, this.client, undefined, this.registered);
      const known = this.known;
      if (
        known &&
        Date.now() - known.at < (this.options.refreshMs ?? 60_000) &&
        desired.every((address) => known.addresses.has(address.toBase58()))
      )
        return { extended: 0, created: 0, skipped: false as const };
      const tables = await this.tables();
      this.known = {
        addresses: new Set(tables.filter((t) => t.active).flatMap((t) => t.addresses.map(String))),
        at: Date.now(),
      };
      const plan = planLookupExtensions(tables, desired);
      let extended = 0,
        created = 0;
      const extend = async (table: PublicKey, addresses: PublicKey[]) => {
        this.known = undefined; // Re-read after writing.
        await this.send(
          AddressLookupTableProgram.extendLookupTable({
            lookupTable: table,
            authority: this.authority.publicKey,
            payer: this.authority.publicKey,
            addresses,
          }),
        );
        extended += addresses.length;
        this.spent += addresses.length;
        transactions--;
      };
      for (const step of plan.extend) {
        if (transactions <= 0 || extended + step.addresses.length > budget) return { extended, created, skipped: false as const };
        await extend(step.table, step.addresses);
      }
      for (const batch of plan.pending) {
        if (transactions <= 1 || extended + Math.min(batch.length, 20) > budget) break;
        this.known = undefined;
        const slot = await this.connection.getSlot("finalized");
        const [instruction, table] = AddressLookupTableProgram.createLookupTable({
          authority: this.authority.publicKey,
          payer: this.authority.publicKey,
          recentSlot: slot,
        });
        await this.send(instruction);
        // Register before extending so an interrupted pass still finds it.
        await this.registry.putLookupTable(this.domain, table.toBase58(), this.authority.publicKey.toBase58(), slot);
        created++;
        transactions--;
        for (let i = 0; i < batch.length && transactions > 0; i += 20) {
          const chunk = batch.slice(i, i + 20);
          if (extended + chunk.length > budget) break;
          await extend(table, chunk);
        }
        // Later batches continue next pass (the new table is then counted with room).
        break;
      }
      return { extended, created, skipped: false as const };
    } finally {
      this.running = false;
    }
  }

  private async send(instruction: TransactionInstruction) {
    const latest = await this.connection.getLatestBlockhash("confirmed");
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: this.authority.publicKey,
        recentBlockhash: latest.blockhash,
        instructions: [instruction],
      }).compileToV0Message(),
    );
    tx.sign([this.authority]);
    const signature = await this.connection.sendRawTransaction(tx.serialize());
    const result = await this.connection.confirmTransaction({ signature, ...latest }, "confirmed");
    if (result.value.err) throw new Error("Lookup table keeper transaction failed: " + JSON.stringify(result.value.err));
    return signature;
  }
}
