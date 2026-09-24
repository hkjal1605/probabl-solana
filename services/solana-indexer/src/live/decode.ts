/** Incremental program-state projection. Each committed slot touches only its
 * changed accounts, producing a new immutable `Snapshot` (maps are copied only
 * for the kinds that changed), so a reader holding a snapshot across awaits
 * never observes a half-applied slot. */
import { PublicKey } from "@solana/web3.js";
import {
  assetCreditAddress,
  coder,
  delegationAddress,
  marketAddress,
  orderId,
  orderWire,
  poolAddress,
  traderAddress,
  walletAddress,
  type AssetCreditAccount,
  type AssetPoolAccount,
  type ConfigAccount,
  type MarketAccount,
  type OrderAccount,
  type SolanaClient,
  type TraderAccount,
  type TradingDelegateAccount,
  type WalletAccount,
} from "@conditional-stocks/solana-client";
import type { Snapshot } from "../projection.ts";

type Client = Pick<SolanaClient, "program" | "config">;
export type ProgramKind = "config" | "pool" | "delegation" | "trader" | "market" | "credit" | "order" | "wallet";
type MapKind = Exclude<ProgramKind, "config">;
const MAP: Record<MapKind, "pools" | "delegations" | "traders" | "markets" | "credits" | "orders" | "wallets"> = {
  pool: "pools",
  delegation: "delegations",
  trader: "traders",
  market: "markets",
  credit: "credits",
  order: "orders",
  wallet: "wallets",
};
/** Kinds whose validity depends on another kind being present first. */
const DEPENDENT = new Set<ProgramKind>(["credit", "order", "wallet"]);

export interface Decoded {
  kind: ProgramKind;
  /** Map key: the account address, except traders (keyed by owner). */
  key: string;
  value: unknown;
}

/** Decodes and authenticates one program account. Accounts of other
 * deployments (another config) or of unknown markets/pools are ignored.
 * A program account at a non-canonical address is an integrity failure. */
export function decodeProgramAccount(
  client: Client,
  id: string,
  data: Buffer,
  known: { market(id: string): boolean; pool(id: string): boolean },
): Decoded | null {
  if (id === client.config.toBase58()) return { kind: "config", key: id, value: coder.accounts.decode("Config", data) as ConfigAccount };
  let decoded: Record<string, unknown> | null;
  try {
    decoded = coder.accounts.decodeAny(data) as Record<string, unknown>;
  } catch {
    return null; // Not a program account type we project (e.g. closed/zeroed).
  }
  if (!decoded) return null;
  if ("liability" in decoded && "token_program" in decoded) {
    const pool = decoded as unknown as AssetPoolAccount;
    if (!pool.config.equals(client.config)) return null;
    if (poolAddress(client.config, pool.mint, client.program).toBase58() !== id) throw new Error("Invalid asset pool PDA");
    return { kind: "pool", key: id, value: pool };
  }
  if ("remaining_quote" in decoded && "delegate" in decoded) {
    const grant = decoded as unknown as TradingDelegateAccount;
    if (!grant.config.equals(client.config)) return null;
    if (delegationAddress(client.config, grant.owner, grant.delegate, client.program).toBase58() !== id)
      throw new Error("Invalid delegation PDA");
    return { kind: "delegation", key: id, value: grant };
  }
  if ("minimum_nonce" in decoded && "config" in decoded) {
    const trader = decoded as unknown as TraderAccount;
    if (!trader.config.equals(client.config)) return null;
    if (traderAddress(client.config, trader.owner, client.program).toBase58() !== id) throw new Error("Invalid trader PDA");
    return { kind: "trader", key: trader.owner.toBase58(), value: trader };
  }
  if ("terms" in decoded && "mints" in decoded) {
    const market = decoded as unknown as MarketAccount;
    if (!market.config.equals(client.config)) return null;
    if (marketAddress(client.config, Uint8Array.from(market.id), client.program).toBase58() !== id)
      throw new Error("Invalid market PDA");
    return { kind: "market", key: id, value: market };
  }
  if ("available" in decoded && "pool" in decoded) {
    const credit = decoded as unknown as AssetCreditAccount;
    if (!known.pool(credit.pool.toBase58())) return null;
    if (assetCreditAddress(credit.pool, credit.owner, client.program).toBase58() !== id)
      throw new Error("Invalid asset credit PDA");
    return { kind: "credit", key: id, value: credit };
  }
  if (!("market" in decoded) || !known.market((decoded.market as PublicKey).toBase58())) return null;
  if ("terms" in decoded) {
    const order = decoded as unknown as OrderAccount;
    if (orderId(orderWire(order), client.program) !== id) throw new Error("Invalid order PDA");
    return { kind: "order", key: id, value: order };
  }
  if (!("balances" in decoded)) return null;
  const wallet = decoded as unknown as WalletAccount;
  if (walletAddress(wallet.market, wallet.owner, client.program).toBase58() !== id) throw new Error("Invalid wallet PDA");
  return { kind: "wallet", key: id, value: wallet };
}

const emptyMaps = () => ({
  markets: new Map(),
  orders: new Map(),
  wallets: new Map(),
  traders: new Map(),
  pools: new Map(),
  credits: new Map(),
  delegations: new Map(),
});

export class ProgramView {
  private current: Snapshot | undefined;
  /** address -> projected entry, for removals and kind changes. */
  private readonly index = new Map<string, Decoded>();
  constructor(private readonly client: Client) {}

  get snapshot(): Snapshot {
    if (!this.current) throw new Error("Program view is not bootstrapped");
    return this.current;
  }
  get ready() {
    return this.current !== undefined;
  }

  /** Full projection (bootstrap or after a fork rebuild). */
  rebuild(slot: number, accounts: Iterable<[string, Buffer]>): Snapshot {
    this.index.clear();
    const next = { program: this.client.program, slot, observedAt: Date.now(), ...emptyMaps() } as Snapshot;
    const all = [...accounts];
    let config: ConfigAccount | undefined;
    for (const pass of [false, true])
      for (const [id, data] of all) {
        const decoded = decodeProgramAccount(this.client, id, data, {
          market: (m) => next.markets.has(m),
          pool: (p) => next.pools.has(p),
        });
        if (!decoded || DEPENDENT.has(decoded.kind) !== pass) continue;
        if (decoded.kind === "config") config = decoded.value as ConfigAccount;
        else (next[MAP[decoded.kind]] as Map<string, unknown>).set(decoded.key, decoded.value);
        this.index.set(id, decoded);
      }
    if (!config) throw new Error("Deployment config is missing");
    next.config = config;
    this.current = next;
    return next;
  }

  /** Applies one committed slot's changes (`undefined` = closed). Returns the
   * addresses whose projection changed. */
  apply(slot: number, changes: Iterable<[string, Buffer | undefined]>): { snapshot: Snapshot; changed: Set<string> } {
    const previous = this.snapshot;
    const next: Snapshot = { ...previous, slot, observedAt: Date.now() };
    const copied = new Set<string>();
    const map = (kind: MapKind) => {
      const name = MAP[kind];
      if (!copied.has(name)) {
        (next as unknown as Record<string, unknown>)[name] = new Map(previous[name] as Map<string, unknown>);
        copied.add(name);
      }
      return next[name] as Map<string, unknown>;
    };
    const changed = new Set<string>();
    const list = [...changes];
    for (const [id] of list) {
      const old = this.index.get(id);
      if (!old) continue;
      if (old.kind !== "config") map(old.kind).delete(old.key);
      this.index.delete(id);
      changed.add(id);
    }
    for (const pass of [false, true])
      for (const [id, data] of list) {
        if (!data) continue;
        const decoded = decodeProgramAccount(this.client, id, data, {
          market: (m) => next.markets.has(m),
          pool: (p) => next.pools.has(p),
        });
        if (!decoded || DEPENDENT.has(decoded.kind) !== pass) continue;
        if (decoded.kind === "config") next.config = decoded.value as ConfigAccount;
        else map(decoded.kind).set(decoded.key, decoded.value);
        this.index.set(id, decoded);
        changed.add(id);
      }
    this.current = next;
    return { snapshot: next, changed };
  }

  /** The projected kind of an address, if any. */
  kindOf(id: string): ProgramKind | undefined {
    return this.index.get(id)?.kind;
  }
}
