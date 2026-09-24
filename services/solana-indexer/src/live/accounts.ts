/** Commitment-aware account state fed by a Geyser (Yellowstone gRPC) stream.
 *
 * Updates for a slot are staged until that slot is confirmed, then committed
 * atomically to the confirmed view (so readers never see half a slot). They are
 * folded into the finalized view only when a descendant-or-equal slot is
 * finalized and the slot is on the finalized chain; updates of dead or
 * abandoned forks are discarded and the confirmed view is rebuilt from the
 * finalized base plus the surviving confirmed slots. Ordering within an account
 * is by (slot, write_version), so replayed or duplicated updates are harmless. */

export interface AccountVersion {
  slot: number;
  writeVersion: bigint;
  owner: string;
  lamports: bigint;
  data: Buffer;
}

export type Commitment = "confirmed" | "finalized";

/** A closed account: zero lamports. Kept as a version so ordering still holds. */
export const isTombstone = (v: AccountVersion) => v.lamports === 0n;

const newer = (a: AccountVersion, b: AccountVersion | undefined) =>
  !b || a.slot > b.slot || (a.slot === b.slot && a.writeVersion > b.writeVersion);

export interface CommitResult {
  commitment: Commitment;
  slot: number;
  /** Addresses whose visible version changed in that view. */
  changed: Set<string>;
  /** The whole view was rebuilt (fork pruned): consumers must re-derive everything. */
  rebuilt: boolean;
}

export class AccountStore {
  finalizedSlot = -1;
  confirmedSlot = -1;
  private readonly finalizedView = new Map<string, AccountVersion>();
  private confirmedView = new Map<string, AccountVersion>();
  /** Received but not yet confirmed, by slot. */
  private readonly staged = new Map<number, Map<string, AccountVersion>>();
  /** Confirmed but not yet finalized, by slot. */
  private readonly pending = new Map<number, Map<string, AccountVersion>>();
  private readonly parents = new Map<number, number>();

  /** A finalized base image (RPC snapshot) at `slot`; clears everything newer. */
  bootstrap(slot: number, accounts: Iterable<[string, AccountVersion]>) {
    this.finalizedView.clear();
    for (const [address, version] of accounts) this.finalizedView.set(address, version);
    this.confirmedView = new Map(this.finalizedView);
    this.staged.clear();
    this.pending.clear();
    this.parents.clear();
    this.finalizedSlot = this.confirmedSlot = slot;
  }

  get(commitment: Commitment, address: string): AccountVersion | undefined {
    const version = (commitment === "finalized" ? this.finalizedView : this.confirmedView).get(address);
    return version && !isTombstone(version) ? version : undefined;
  }

  /** Live (non-closed) entries of a view. */
  *entries(commitment: Commitment): Iterable<[string, AccountVersion]> {
    for (const entry of commitment === "finalized" ? this.finalizedView : this.confirmedView)
      if (!isTombstone(entry[1])) yield entry;
  }

  account(address: string, version: AccountVersion) {
    if (version.slot <= this.finalizedSlot) return; // Already folded into the base.
    let slot = this.staged.get(version.slot);
    if (!slot) this.staged.set(version.slot, (slot = new Map()));
    if (newer(version, slot.get(address))) slot.set(address, version);
  }

  /** An externally read current value for a newly tracked account (the stream
   * only delivers later changes). Never overrides a newer streamed version. */
  seed(address: string, version: AccountVersion) {
    if (newer(version, this.finalizedView.get(address))) this.finalizedView.set(address, version);
    if (newer(version, this.confirmedView.get(address))) this.confirmedView.set(address, version);
  }

  /** Records parentage (sent with processed status) for fork-aware finalization. */
  parent(slot: number, parent: number) {
    this.parents.set(slot, parent);
  }

  /** Commits every staged slot <= `slot` to the confirmed view. */
  confirm(slot: number): CommitResult {
    const changed = new Set<string>();
    for (const staged of [...this.staged.keys()].filter((s) => s <= slot).sort((a, b) => a - b)) {
      const updates = this.staged.get(staged)!;
      this.staged.delete(staged);
      const pending = this.pending.get(staged) ?? new Map<string, AccountVersion>();
      for (const [address, version] of updates) {
        if (newer(version, pending.get(address))) pending.set(address, version);
        if (newer(version, this.confirmedView.get(address))) {
          this.confirmedView.set(address, version);
          changed.add(address);
        }
      }
      this.pending.set(staged, pending);
    }
    if (slot > this.confirmedSlot) this.confirmedSlot = slot;
    return { commitment: "confirmed", slot, changed, rebuilt: false };
  }

  /** Folds confirmed slots on the chain ending at `slot` into the finalized
   * view; drops slots that are not ancestors (abandoned forks). */
  finalize(slot: number): { finalized: CommitResult; confirmed?: CommitResult; onChain(slot: number): boolean } {
    if (slot <= this.finalizedSlot)
      return { finalized: { commitment: "finalized", slot, changed: new Set(), rebuilt: false }, onChain: () => false };
    // A slot finalizes only after it is confirmed; commit anything still staged.
    const confirmed = this.staged.size ? this.confirm(slot) : undefined;
    // Walk parentage down to the previous finalized slot. Only a complete walk
    // proves which slots are abandoned; with any gap (missed processed status,
    // replay without parentage) every confirmed slot is kept, as the stream
    // then carries a single confirmed chain.
    const chain = new Set<number>([slot]);
    let cursor = slot,
      known = false;
    for (;;) {
      const parent = this.parents.get(cursor);
      if (parent === undefined) break;
      if (parent <= this.finalizedSlot) {
        known = true;
        break;
      }
      chain.add(parent);
      cursor = parent;
    }
    const changed = new Set<string>();
    let abandoned = false;
    for (const pendingSlot of [...this.pending.keys()].filter((s) => s <= slot).sort((a, b) => a - b)) {
      const updates = this.pending.get(pendingSlot)!;
      this.pending.delete(pendingSlot);
      if (known && !chain.has(pendingSlot)) {
        abandoned = true;
        continue;
      }
      for (const [address, version] of updates)
        if (newer(version, this.finalizedView.get(address))) {
          this.finalizedView.set(address, version);
          changed.add(address);
        }
    }
    for (const s of [...this.parents.keys()]) if (s <= slot) this.parents.delete(s);
    this.finalizedSlot = slot;
    if (this.confirmedSlot < slot) this.confirmedSlot = slot;
    const finalized: CommitResult = { commitment: "finalized", slot, changed, rebuilt: false };
    /** Whether a newly finalized slot is on the finalized chain (its
     * transactions are final); unknown parentage keeps every slot. */
    const onChain = (s: number) => !known || chain.has(s);
    if (!abandoned) return { finalized, ...(confirmed ? { confirmed } : {}), onChain };
    return { finalized, confirmed: this.rebuildConfirmed(), onChain };
  }

  /** A slot that will never be confirmed or finalized. */
  dead(slot: number): CommitResult | undefined {
    this.staged.delete(slot);
    if (!this.pending.delete(slot)) return undefined;
    return this.rebuildConfirmed();
  }

  private rebuildConfirmed(): CommitResult {
    const view = new Map(this.finalizedView);
    for (const slot of [...this.pending.keys()].sort((a, b) => a - b))
      for (const [address, version] of this.pending.get(slot)!)
        if (newer(version, view.get(address))) view.set(address, version);
    const changed = new Set<string>();
    for (const address of new Set([...view.keys(), ...this.confirmedView.keys()]))
      if (view.get(address) !== this.confirmedView.get(address)) changed.add(address);
    this.confirmedView = view;
    return { commitment: "confirmed", slot: this.confirmedSlot, changed, rebuilt: true };
  }

  /** Bounded memory: slots waiting for confirmation or finalization. */
  backlog() {
    return { staged: this.staged.size, pending: this.pending.size };
  }
}
