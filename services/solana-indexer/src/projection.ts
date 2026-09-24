import { PublicKey } from "@solana/web3.js";
import { ProgramView } from "./live/decode.ts";
import {
  SolanaClient,
  big,
  hex,
  orderWire,
  walletAddress,
  delegationAddress,
  activeDelegation,
  claimAsset,
  legBit,
  orderCollateral,
  singleBase,
  underlyingAsset,
  type LiveLeg,
  type AssetPoolAccount,
  type AssetCreditAccount,
  type TradingDelegateAccount,
  type ConfigAccount,
  type MarketAccount,
  type OrderAccount,
  type WalletAccount,
  type TraderAccount,
} from "@conditional-stocks/solana-client";

export interface Snapshot {
  rawAccounts?: { address: string; data: string }[];
  program: PublicKey;
  slot: number;
  observedAt: number;
  /** Verified creation event times, indexed from finalized program history. */
  createdAt?: Map<string, string>;
  config: ConfigAccount;
  markets: Map<string, MarketAccount>;
  orders: Map<string, OrderAccount>;
  wallets: Map<string, WalletAccount>;
  traders: Map<string, TraderAccount>;
  pools: Map<string, AssetPoolAccount>;
  credits: Map<string, AssetCreditAccount>;
  delegations?: Map<string, TradingDelegateAccount>;
  /** Live issuer state of every listed base leg, by market then collateral.
   * Read separately from the program image (issuer mints and pool vaults). */
  legs?: Map<string, Record<number, LiveLeg>>;
}
export async function snapshot(
  client: SolanaClient,
  commitment: "confirmed" | "finalized" = "finalized",
): Promise<Snapshot> {
  await client.assertNetwork();
  const response = await client.connection.getProgramAccounts(client.program, {
    commitment,
    withContext: true,
  });
  return decodeSnapshot(
    client,
    response.context.slot,
    response.value
      .map((a) => ({ address: a.pubkey.toBase58(), data: a.account.data.toString("base64") }))
      .sort((a, b) => a.address.localeCompare(b.address)),
  );
}

/** Decodes one committed program account image (one-shot reads and tooling;
 * the live index applies the same decoder incrementally). */
export function decodeSnapshot(
  client: Pick<SolanaClient, "program" | "config">,
  slot: number,
  rawAccounts: { address: string; data: string }[],
): Snapshot {
  const s = new ProgramView(client).rebuild(
    slot,
    rawAccounts.map((a) => [a.address, Buffer.from(a.data, "base64")] as [string, Buffer]),
  );
  return { ...s, rawAccounts };
}
/** Every listed collateral's underlying + YES + NO custody is initialized. */
export const collateralReady = (m: MarketAccount, collateral: number) => {
  const bits = 0b111 << underlyingAsset(collateral);
  return collateral <= m.bases && (m.vaults_initialized & bits) === bits;
};
/** Both claim mints of a listed collateral exist (positions/claims are readable). */
export const claimsReady = (m: MarketAccount, collateral: number) => {
  const bits = (1 << claimAsset(collateral, 0)) | (1 << claimAsset(collateral, 1));
  return collateral <= m.bases && (m.vaults_initialized & bits) === bits;
};
/** JSON form of a live leg (`bases[].live`). */
export function liveLegView(leg: LiveLeg) {
  return {
    multiplier: leg.multiplier.toString(),
    multiplierValue: leg.multiplierValue,
    paused: leg.paused,
    vaultFrozen: leg.vaultFrozen,
    tradable: leg.tradable,
    halt: leg.halt,
  };
}
/** Indexed JSON contract, protocolVersion 3 (docs/multi-issuer-markets.md). */
export function marketView(
  id: string,
  m: MarketAccount,
  createdAt?: string,
  live?: Record<number, LiveLeg>,
) {
  const t = m.terms;
  const mint = (asset: number) => m.mints[asset]!.toBase58();
  return {
    id,
    createdAt: createdAt ?? null,
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
    quoteToken: mint(underlyingAsset(0)),
    quoteTokenDecimals: m.decimals[0]!,
    shareDecimals: t.share_decimals,
    quoteClaimMints: { yes: mint(claimAsset(0, 0)), no: mint(claimAsset(0, 1)) },
    bases: Array.from({ length: m.bases }, (_, i) => {
      const collateral = i + 1,
        leg = m.legs[i]!,
        state = live?.[collateral];
      return {
        collateral,
        bit: legBit(collateral),
        mint: mint(underlyingAsset(collateral)),
        decimals: m.decimals[collateral]!,
        scale: leg.scale.toString(),
        listingMultiplier: leg.multiplier.toString(),
        active: leg.active,
        ready: collateralReady(m, collateral),
        claimMints: {
          yes: mint(claimAsset(collateral, 0)),
          no: mint(claimAsset(collateral, 1)),
        },
        ...(state ? { live: liveLegView(state) } : {}),
      };
    }),
    claimMints: m.mints.map((k) => k.toBase58()),
    protocolVersion: 3,
    priceFormat: "share-unit-ratio-x18",
  };
}
export type MarketView = ReturnType<typeof marketView>;
export function indexedOrder(id: string, o: OrderAccount, slot: number) {
  const wire = orderWire(o);
  return {
    ...wire,
    id,
    /** Delivered issuer leg of a sell; null for bids (see `bases`). */
    baseCollateral: wire.side === 1 ? orderCollateral(wire) : null,
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
  if (!o.delegate.equals(PublicKey.default)) {
    if (!m || !trader) return false;
    const grant = s.delegations?.get(
      delegationAddress(m.config, o.owner, o.delegate, s.program).toBase58(),
    );
    if (!grant || !activeDelegation(grant, big(trader.delegation_epoch), o.market, now))
      return false;
  }
  // An ask of a delisted (or unlisted) leg can never fill; it is publicly
  // releasable, not resting liquidity.
  if (m && o.terms.side === 1) {
    const collateral = singleBase(o.terms.bases);
    if (collateral === null || collateral > m.bases || !m.legs[collateral - 1]?.active)
      return false;
  }
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
