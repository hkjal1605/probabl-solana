import { PublicKey } from "@solana/web3.js";
import {
  SolanaClient,
  coder,
  big,
  hex,
  orderWire,
  orderId,
  walletAddress,
  marketAddress,
  traderAddress,
  type ConfigAccount,
  type MarketAccount,
  type OrderAccount,
  type WalletAccount,
  type TraderAccount,
} from "@conditional-stocks/solana-client";

export interface Snapshot {
  program: PublicKey;
  slot: number;
  observedAt: number;
  config: ConfigAccount;
  markets: Map<string, MarketAccount>;
  orders: Map<string, OrderAccount>;
  wallets: Map<string, WalletAccount>;
  traders: Map<string, TraderAccount>;
}
export async function snapshot(client: SolanaClient): Promise<Snapshot> {
  await client.assertNetwork();
  const response = await client.connection.getProgramAccounts(client.program, {
    commitment: "finalized",
    withContext: true,
  });
  const byKey = new Map(response.value.map((a) => [a.pubkey.toBase58(), a.account]));
  const configInfo = byKey.get(client.config.toBase58());
  if (!configInfo) throw new Error("Deployment config is missing");
  const config = coder.accounts.decode("Config", configInfo.data) as ConfigAccount;
  const result: Snapshot = {
    program: client.program,
    slot: response.context.slot,
    observedAt: Date.now(),
    config,
    markets: new Map(),
    orders: new Map(),
    wallets: new Map(),
    traders: new Map(),
  };
  const decoded = response.value.map(({ pubkey, account }) => ({
    id: pubkey.toBase58(),
    data: coder.accounts.decodeAny(account.data),
  }));
  for (const { id, data } of decoded) {
    if (data && "minimum_nonce" in data && "config" in data) {
      const t = data as TraderAccount;
      if (t.config.equals(client.config)) {
        if (traderAddress(client.config, t.owner, client.program).toBase58() !== id)
          throw new Error("Invalid trader PDA");
        result.traders.set(t.owner.toBase58(), t);
      }
    }
    if (data && "terms" in data && "mints" in data) {
      const m = data as MarketAccount;
      if (!m.config.equals(client.config)) continue;
      if (marketAddress(client.config, Uint8Array.from(m.id), client.program).toBase58() !== id)
        throw new Error("Invalid market PDA");
      result.markets.set(id, m);
    }
  }
  for (const { id, data } of decoded) {
    if (!data || !("market" in data) || !result.markets.has((data.market as PublicKey).toBase58()))
      continue;
    if ("terms" in data) {
      const o = data as OrderAccount;
      if (orderId(orderWire(o), client.program) !== id) throw new Error("Invalid order PDA");
      result.orders.set(id, o);
    } else if ("balances" in data) {
      const w = data as WalletAccount;
      if (walletAddress(w.market, w.owner, client.program).toBase58() !== id)
        throw new Error("Invalid wallet PDA");
      result.wallets.set(id, w);
    }
  }
  return result;
}
export function marketView(id: string, m: MarketAccount) {
  const t = m.terms;
  return {
    id,
    baseToken: m.mints[0]!.toBase58(),
    quoteToken: m.mints[1]!.toBase58(),
    conditionId: id,
    polymarketConditionId: hex(t.condition),
    polymarketYesIndex: String(t.yes_index),
    polymarketNoIndex: String(t.no_index),
    rulesHash: hex(t.rules_hash),
    metadataHash: hex(t.metadata_hash),
    metadataUri: t.metadata_uri,
    state: m.state,
    tradingOpen: t.trading_open.toString(),
    tradingCutoff: t.trading_cutoff.toString(),
    priceTickRawX18: t.tick.toString(),
    baseStep: t.step.toString(),
    minNotional: t.min_notional.toString(),
    maxOrderQuantity: t.max_quantity.toString(),
    maxOrderNotional: t.max_order.toString(),
    maxWalletOpenNotional: t.max_wallet.toString(),
    maxMarketOpenNotional: t.max_market.toString(),
    baseTokenDecimals: m.decimals[0],
    quoteTokenDecimals: m.decimals[1],
    protocolVersion: 2,
    priceFormat: "raw-unit-ratio-x18",
    claimMints: m.mints.slice(2).map((k) => k.toBase58()),
  };
}
export function indexedOrder(id: string, o: OrderAccount, slot: number) {
  const wire = orderWire(o);
  return {
    ...wire,
    id,
    remaining: o.remaining.toString(),
    reserved: o.reserved.toString(),
    filled: o.filled.toString(),
    sequence: o.sequence.toString(),
    openNotional: o.open_notional.toString(),
    status: ["none", "open", "filled", "cancelled"][o.status],
    confirmation: "finalized",
    updatedBlock: String(slot),
  };
}
export function liveOrder(
  o: OrderAccount,
  s: Snapshot,
  now = BigInt(Math.floor(Date.now() / 1000)),
) {
  const m = s.markets.get(o.market.toBase58()),
    w = s.wallets.get(walletAddress(o.market, o.owner, s.program).toBase58());
  const trader = s.traders.get(o.owner.toBase58());
  return Boolean(
    m &&
      w &&
      trader &&
      !s.config.paused &&
      o.status === 1 &&
      m.state === 2 &&
      big(m.terms.trading_cutoff) > now &&
      big(o.terms.expiry) > now &&
      big(o.terms.nonce) >= big(trader.minimum_nonce),
  );
}
