import { expect } from "bun:test";
import { type PublicKey } from "@solana/web3.js";
import { unpackAccount, unpackMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  SolanaClient,
  big,
  coder,
  walletAddress,
  vaultAddress,
  claimAddress,
  type MarketAccount,
  type WalletAccount,
  type OrderAccount,
} from "../src/index.ts";

/** Test-only, same-RPC-snapshot accounting oracle. Callers must supply EVERY
 * fixture wallet and order, including completed/cancelled order tombstones.
 * Supply includes claims held outside the protocol, not just vault balances.
 * This is not a new runtime invariant or a production indexer check. */
export async function assertMarketInvariants(
  client: SolanaClient,
  market: PublicKey,
  owners: PublicKey[],
  orderKeys: PublicKey[] = [],
) {
  const addresses = [
    market,
    ...Array.from({ length: 6 }, (_, i) => vaultAddress(market, i)),
    ...Array.from({ length: 4 }, (_, i) => claimAddress(market, i + 2)),
    ...owners.map((owner) => walletAddress(market, owner)),
    ...orderKeys,
  ];
  const accounts = await client.connection.getMultipleAccountsInfo(
    addresses,
    "confirmed",
  );
  expect(accounts.every(Boolean)).toBe(true);
  const state = coder.accounts.decode(
    "Market",
    accounts[0]!.data,
  ) as MarketAccount;
  const wallets = owners.map(
    (_, i) =>
      coder.accounts.decode("Wallet", accounts[11 + i]!.data) as WalletAccount,
  );
  const orders = orderKeys.map(
    (_, i) =>
      coder.accounts.decode(
        "Order",
        accounts[11 + owners.length + i]!.data,
      ) as OrderAccount,
  );
  const supplies = Array.from({ length: 4 }, (_, i) => {
    const mint = unpackMint(
      addresses[7 + i]!,
      accounts[7 + i]!,
      TOKEN_PROGRAM_ID,
    );
    expect(mint.mintAuthority?.equals(market)).toBe(true);
    expect(mint.freezeAuthority).toBeNull();
    expect(mint.decimals).toBe(state.decimals[Math.floor(i / 2)]!);
    return mint.supply;
  });
  for (let asset = 0; asset < 6; asset++) {
    const info = accounts[1 + asset]!;
    const vault = unpackAccount(addresses[1 + asset]!, info, info.owner);
    const credits = wallets.reduce(
      (sum, wallet) => sum + big(wallet.balances[asset]!),
      0n,
    );
    const escrow = orders.reduce((sum, order) => {
      const collateral = order.terms.side === 0 ? 1 : 0;
      const funding =
        order.terms.funding === 0
          ? collateral
          : 2 + 2 * collateral + order.terms.branch;
      return sum + (funding === asset ? big(order.reserved) : 0n);
    }, 0n);
    expect(big(state.credits[asset]!)).toBe(credits);
    expect(big(state.escrow[asset]!)).toBe(escrow);
    expect(vault.owner.equals(market)).toBe(true);
    expect(vault.mint.equals(state.mints[asset]!)).toBe(true);
    const extra = big(
      asset < 2 ? state.backing[asset]! : state.fees[asset - 2]!,
    );
    expect(vault.amount).toBeGreaterThanOrEqual(credits + escrow + extra);
    if (asset >= 2)
      expect(supplies[asset - 2]!).toBeGreaterThanOrEqual(vault.amount);
  }
  for (let collateral = 0; collateral < 2; collateral++) {
    const yes = supplies[collateral * 2]!,
      no = supplies[collateral * 2 + 1]!;
    let potential = yes > no ? yes : no;
    if ([6, 7].includes(state.state)) {
      const y = BigInt(state.payouts[0]!),
        n = BigInt(state.payouts[1]!);
      expect(y + n).toBeGreaterThan(0n);
      // A conservative CEILING also covers merge after INVALID resolution.
      potential = (yes * y + no * n + y + n - 1n) / (y + n);
    }
    expect(big(state.backing[collateral]!)).toBeGreaterThanOrEqual(potential);
  }
  expect(big(state.open_notional)).toBe(
    orders.reduce((sum, o) => sum + big(o.open_notional), 0n),
  );
  for (const wallet of wallets) {
    expect(big(wallet.open_notional)).toBe(
      orders.reduce(
        (sum, o) =>
          sum + (o.owner.equals(wallet.owner) ? big(o.open_notional) : 0n),
        0n,
      ),
    );
  }
  return state;
}
