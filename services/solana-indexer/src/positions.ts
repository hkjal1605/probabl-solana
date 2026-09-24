import { getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import {
  big,
  claimAsset,
  coder,
  key,
  underlyingAsset,
  walletAddress,
  type MarketAccount,
  type SolanaClient,
  type WalletAccount,
} from "@conditional-stocks/solana-client";
import { claimsReady, type Snapshot } from "./projection.ts";
import type { AccountInfo } from "@solana/web3.js";

/** Claim assets of every listed collateral whose claim mints exist, quote first. */
export function positionAssets(m: MarketAccount) {
  const assets: number[] = [];
  for (let c = 0; c <= m.bases; c++)
    if (claimsReady(m, c)) assets.push(claimAsset(c, 0), claimAsset(c, 1));
  return assets;
}

/** Indexed position (protocolVersion 3). Claim amounts are raw units of their
 * own mint. Markets whose quote claims are not initialized have no position. */
export function positionView(id: string, m: MarketAccount, amount: (asset: number) => bigint) {
  if (!claimsReady(m, 0)) return [];
  const value = (asset: number) => amount(asset).toString();
  const bases = [];
  for (let c = 1; c <= m.bases; c++)
    if (claimsReady(m, c))
      bases.push({
        collateral: c,
        mint: m.mints[underlyingAsset(c)]!.toBase58(),
        decimals: m.decimals[c]!,
        yes: value(claimAsset(c, 0)),
        no: value(claimAsset(c, 1)),
      });
  const quoteYes = value(claimAsset(0, 0)),
    quoteNo = value(claimAsset(0, 1));
  if ([quoteYes, quoteNo, ...bases.flatMap((b) => [b.yes, b.no])].every((a) => a === "0"))
    return [];
  return [
    {
      marketId: id,
      conditionId: id,
      redeemable: m.state === 6 || m.state === 7,
      shareDecimals: m.terms.share_decimals,
      quoteTokenDecimals: m.decimals[0]!,
      quoteYes,
      quoteNo,
      bases,
      protocolVersion: 3,
    },
  ];
}

/** Read wallet credits and external claims together, at most 100 accounts/RPC.
 * A malformed/partial read fails the entire response, never returns false zeros.
 */
export async function readPositions(
  client: Pick<SolanaClient, "program" | "connection">,
  s: Snapshot,
  owner: ReturnType<typeof key>,
) {
  const markets = [...s.markets]
    .map(([id, m]) => ({ id, m, assets: positionAssets(m) }))
    .filter(({ assets }) => assets.length);
  const addresses = markets.flatMap(({ id, m, assets }) => [
    walletAddress(key(id), owner, client.program),
    ...assets.map((asset) => getAssociatedTokenAddressSync(m.mints[asset]!, owner, true)),
  ]);
  const infos: (AccountInfo<Buffer> | null)[] = [];
  let slot = s.slot;
  for (let start = 0; start < addresses.length; start += 100) {
    const chunk = addresses.slice(start, start + 100);
    const response = await client.connection.getMultipleAccountsInfoAndContext(chunk, {
      commitment: "finalized",
      minContextSlot: s.slot,
    });
    if (
      !Number.isSafeInteger(response.context.slot) ||
      response.context.slot < s.slot ||
      response.value.length !== chunk.length
    )
      throw new Error("Incomplete finalized position read");
    slot = Math.max(slot, response.context.slot);
    infos.push(...response.value);
  }
  let offset = 0;
  const positions = markets.flatMap(({ id, m, assets }) => {
    const base = offset;
    offset += 1 + assets.length;
    const info = infos[base];
    if (info && !info.owner.equals(client.program))
      throw new Error("Foreign position credit account");
    const w = info ? (coder.accounts.decode("Wallet", info.data) as WalletAccount) : null;
    if (w && (!w.market.equals(key(id)) || !w.owner.equals(owner)))
      throw new Error("Position credit identity mismatch");
    const amounts = new Map<number, bigint>();
    for (const [i, asset] of assets.entries()) {
      const mint = m.mints[asset]!;
      const tokenInfo = infos[base + 1 + i];
      let external = 0n;
      if (tokenInfo) {
        const account = unpackAccount(addresses[base + 1 + i]!, tokenInfo);
        if (!account.owner.equals(owner) || !account.mint.equals(mint))
          throw new Error("Position token identity mismatch");
        external = account.amount;
      }
      amounts.set(asset, external + (w ? big(w.balances[asset]!) : 0n));
    }
    return positionView(id, m, (asset) => amounts.get(asset) ?? 0n);
  });
  return { positions, observedAt: Date.now(), blockNumber: String(slot) };
}
