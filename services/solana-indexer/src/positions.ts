import { getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import {
  big,
  coder,
  key,
  walletAddress,
  type SolanaClient,
  type WalletAccount,
} from "@conditional-stocks/solana-client";
import type { Snapshot } from "./projection.ts";
import type { AccountInfo } from "@solana/web3.js";

/** Read wallet credits and external claims together, at most 100 accounts/RPC.
 * A malformed/partial read fails the entire response, never returns false zeros.
 */
export async function readPositions(
  client: Pick<SolanaClient, "program" | "connection">,
  s: Snapshot,
  owner: ReturnType<typeof key>,
) {
  const markets = [...s.markets].filter(([, m]) => m.vaults_initialized === 63);
  const addresses = markets.flatMap(([id, m]) => [
    walletAddress(key(id), owner, client.program),
    ...m.mints.slice(2).map((mint) => getAssociatedTokenAddressSync(mint, owner, true)),
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
  const positions = markets.flatMap(([id, m], index) => {
    const offset = index * 5;
    const info = infos[offset];
    if (info && !info.owner.equals(client.program))
      throw new Error("Foreign position credit account");
    const w = info ? (coder.accounts.decode("Wallet", info.data) as WalletAccount) : null;
    if (w && (!w.market.equals(key(id)) || !w.owner.equals(owner)))
      throw new Error("Position credit identity mismatch");
    const amounts = m.mints.slice(2).map((mint, i) => {
      const tokenInfo = infos[offset + i + 1];
      let external = 0n;
      if (tokenInfo) {
        const account = unpackAccount(addresses[offset + i + 1]!, tokenInfo);
        if (!account.owner.equals(owner) || !account.mint.equals(mint))
          throw new Error("Position token identity mismatch");
        external = account.amount;
      }
      return (external + (w ? big(w.balances[i + 2]!) : 0n)).toString();
    });
    if (amounts.every((n) => n === "0")) return [];
    return [
      {
        marketId: id,
        conditionId: id,
        stockYes: amounts[0],
        stockNo: amounts[1],
        quoteYes: amounts[2],
        quoteNo: amounts[3],
        redeemable: m.state === 6 || m.state === 7,
        baseTokenDecimals: m.decimals[0],
        quoteTokenDecimals: m.decimals[1],
        protocolVersion: 2,
        priceFormat: "raw-unit-ratio-x18",
      },
    ];
  });
  return { positions, observedAt: Date.now(), blockNumber: String(slot) };
}
