import type { Pool } from "pg";
import { getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import { coder, decodeSupportedMint, key, walletAddress, type SolanaClient, type WalletAccount } from "@conditional-stocks/solana-client";
import { ReadCache } from "@conditional-stocks/shared/read-cache";
import type { Snapshot } from "./projection";

export interface WalletImage {
  owner: string;
  observedAt: number;
  blockNumber: string;
  positions: Record<string, unknown>[];
  balances: Record<string, Record<string, unknown>>;
}

/** Shared active-wallet index. Browser reads never start separate per-token RPC loops. */
export class WalletIndex {
  private owners = new Map<string, { touched: number; image?: WalletImage; pending?: Promise<WalletImage> }>();
  private mintReads = new ReadCache(10_000, 4);
  constructor(private client: SolanaClient, private db: Pool, private domain: string,
    private state: () => Snapshot) {}
  async initialize() {
    await this.db.query(`CREATE TABLE IF NOT EXISTS solana_wallet_snapshots (
      domain text NOT NULL, owner text NOT NULL, observed_at timestamptz NOT NULL,
      data jsonb NOT NULL, PRIMARY KEY(domain,owner))`);
  }
  peek(owner: string) { return this.owners.get(owner)?.image; }
  touch(owner: string) {
    key(owner);
    let entry = this.owners.get(owner);
    if (!entry) {
      if (this.owners.size >= 128) throw new Error("Wallet indexing capacity reached");
      entry = { touched: Date.now() }; this.owners.set(owner, entry);
    }
    entry.touched = Date.now();
    return entry;
  }
  async get(owner: string) {
    const entry = this.touch(owner);
    if (entry.image && Date.now() - entry.image.observedAt < 20_000) return entry.image;
    if (entry.pending) return entry.pending;
    entry.pending = this.read(owner).then((image) => { entry.image = image; return image; })
      .finally(() => { delete entry.pending; });
    return entry.pending;
  }
  async refresh() {
    for (const [owner, entry] of this.owners) {
      if (Date.now() - entry.touched > 60_000 && !entry.pending) { this.owners.delete(owner); continue; }
      if (entry.pending) continue;
      entry.pending = this.read(owner).then((image) => { entry.image = image; return image; })
        .finally(() => { delete entry.pending; });
      await entry.pending.catch(() => {}); // Keep last-known data; its timestamp expires on clients.
    }
  }
  private async read(ownerString: string): Promise<WalletImage> {
    const s = this.state(), owner = key(ownerString);
    const mints = [...new Map([...s.markets.values()].flatMap((m) => m.mints.map((mint) => [mint.toBase58(), mint] as const))).values()];
    const batch = async (addresses: ReturnType<typeof key>[]) => {
      const values = [];
      for (let i = 0; i < addresses.length; i += 100) {
        const keys = addresses.slice(i, i + 100);
        const result = await this.client.connection.getMultipleAccountsInfoAndContext(keys, {
          commitment: "finalized", minContextSlot: s.slot,
        });
        if (result.value.length !== keys.length || result.context.slot < s.slot)
          throw new Error("Incomplete indexed wallet read");
        values.push(...result.value);
      }
      return values;
    };
    const mintInfos = await this.mintReads.get(mints.join(","), () => batch(mints));
    const metadata = mints.map((mint, i) => decodeSupportedMint(mint, mintInfos[i] ?? null));
    const atas = mints.map((mint, i) => getAssociatedTokenAddressSync(mint, owner, true, metadata[i]!.program));
    const marketIds = [...s.markets.keys()];
    const wallets = marketIds.map((id) => walletAddress(key(id), owner, this.client.program));
    const accounts = await batch([...atas, ...wallets]);
    const credits = new Map<string, WalletAccount>();
    for (const [i, id] of marketIds.entries()) {
      const info = accounts[atas.length + i];
      if (!info) continue;
      if (!info.owner.equals(this.client.program)) throw new Error("Invalid credit program");
      const w = coder.accounts.decode("Wallet", info.data) as WalletAccount;
      if (!w.market.equals(key(id)) || !w.owner.equals(owner)) throw new Error("Invalid credit identity");
      credits.set(id, w);
    }
    const external = new Map<string, bigint>();
    const balances: WalletImage["balances"] = {};
    const observedAt = Date.now();
    for (const [i, mint] of mints.entries()) {
      const info = accounts[i], meta = metadata[i]!;
      const account = info ? unpackAccount(atas[i]!, info, meta.program) : null;
      if (account && (!account.owner.equals(owner) || !account.mint.equals(mint))) throw new Error("Invalid indexed token identity");
      external.set(mint.toBase58(), account?.amount ?? 0n);
      const creditBalances: Record<string, string> = {};
      for (const [id, market] of s.markets) {
        const asset = market.mints.findIndex((m) => m.equals(mint));
        const wallet = credits.get(id);
        if (asset >= 0 && wallet) creditBalances[id] = wallet.balances[asset]!.toString();
      }
      balances[mint.toBase58()] = { account: ownerString, token: mint.toBase58(), decimals: meta.decimals,
        tokenProgram: meta.program.toBase58(), extensions: meta.extensions, issuerCanFreeze: meta.freezeAuthority !== null,
        amountFormat: "raw-units-decimal-formatted", canonicalBalance: String(account?.amount ?? 0n),
        creditBalances, blockNumber: String(s.slot), observedAt };
    }
    const positions = [...s.markets].flatMap(([id, market]) => {
      if (market.vaults_initialized !== 63) return [];
      const wallet = credits.get(id);
      const amounts = market.mints.slice(2).map((mint, i) => String((external.get(mint.toBase58()) ?? 0n) + BigInt(wallet?.balances[i + 2]?.toString() ?? "0")));
      if (amounts.every((a) => a === "0")) return [];
      return [{ marketId: id, conditionId: id, stockYes: amounts[0], stockNo: amounts[1], quoteYes: amounts[2], quoteNo: amounts[3],
        redeemable: market.state === 6 || market.state === 7, baseTokenDecimals: market.decimals[0], quoteTokenDecimals: market.decimals[1],
        protocolVersion: 2, priceFormat: "raw-unit-ratio-x18" }];
    });
    this.state();
    const image = { owner: ownerString, observedAt, blockNumber: String(s.slot), positions, balances };
    await this.db.query(`INSERT INTO solana_wallet_snapshots VALUES($1,$2,now(),$3::jsonb)
      ON CONFLICT(domain,owner) DO UPDATE SET observed_at=EXCLUDED.observed_at,data=EXCLUDED.data`,
      [this.domain, ownerString, JSON.stringify(image)]);
    return image;
  }
}
