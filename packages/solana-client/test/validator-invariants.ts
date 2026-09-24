import { expect } from "bun:test";
import { type PublicKey } from "@solana/web3.js";
import { unpackAccount, unpackMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  SolanaClient,
  big,
  coder,
  claimAsset,
  fundingAsset,
  poolAddress,
  poolVaultAddress,
  underlyingAsset,
  walletAddress,
  vaultAddress,
  claimAddress,
  type AssetPoolAccount,
  type MarketAccount,
  type WalletAccount,
  type OrderAccount,
} from "../src/index.ts";

const orderFunding = (order: OrderAccount) =>
  fundingAsset({
    side: order.terms.side,
    bases: order.terms.bases,
    fundingKind: order.terms.funding,
    branch: order.terms.branch,
  });

/** Test-only, same-RPC-snapshot accounting oracle for the multi-issuer layout
 * (12 assets: underlying 3c in protocol-wide pools, claims 3c+1/3c+2 in market
 * vaults). Callers must supply EVERY fixture wallet and order, including
 * completed/cancelled order tombstones. Supply includes claims held outside the
 * protocol, not just vault balances. Pool checks are lower bounds: a pool is
 * shared by every market (and user credit) of the same deployment. This is not
 * a new runtime invariant or a production indexer check. */
export async function assertMarketInvariants(
  client: SolanaClient,
  market: PublicKey,
  owners: PublicKey[],
  orderKeys: PublicKey[] = [],
) {
  const program = client.program;
  const head = await client.connection.getAccountInfo(market, "confirmed");
  expect(head).not.toBeNull();
  const listed = (coder.accounts.decode("Market", head!.data) as MarketAccount).bases;
  const collaterals = Array.from({ length: 1 + listed }, (_, c) => c);
  const claims = collaterals.flatMap((c) => [claimAsset(c, 0), claimAsset(c, 1)]);
  // One snapshot: market, claim vaults, claim mints, pools, pool vaults, wallets, orders.
  const addresses = [
    market,
    ...claims.map((a) => vaultAddress(market, a, program)),
    ...claims.map((a) => claimAddress(market, a, program)),
  ];
  const poolStart = addresses.length;
  const decodedHead = coder.accounts.decode("Market", head!.data) as MarketAccount;
  for (const c of collaterals) {
    const pool = poolAddress(decodedHead.config, decodedHead.mints[underlyingAsset(c)]!, program);
    addresses.push(pool, poolVaultAddress(pool, program));
  }
  const walletStart = addresses.length;
  addresses.push(...owners.map((owner) => walletAddress(market, owner, program)), ...orderKeys);
  const accounts = await client.connection.getMultipleAccountsInfo(addresses, "confirmed");
  expect(accounts.every(Boolean)).toBe(true);
  const state = coder.accounts.decode("Market", accounts[0]!.data) as MarketAccount;
  expect(state.bases).toBe(listed);
  expect(state.mints).toHaveLength(12);
  const wallets = owners.map(
    (_, i) => coder.accounts.decode("Wallet", accounts[walletStart + i]!.data) as WalletAccount,
  );
  const orders = orderKeys.map(
    (_, i) =>
      coder.accounts.decode("Order", accounts[walletStart + owners.length + i]!.data) as OrderAccount,
  );
  const credits = (asset: number) => wallets.reduce((sum, w) => sum + big(w.balances[asset]!), 0n);
  const escrow = (asset: number) =>
    orders.reduce((sum, o) => sum + (orderFunding(o) === asset ? big(o.reserved) : 0n), 0n);
  const supplies = new Map<number, bigint>();
  for (const [index, asset] of claims.entries()) {
    const c = Math.floor(asset / 3);
    const mintInfo = accounts[1 + claims.length + index]!;
    const mint = unpackMint(addresses[1 + claims.length + index]!, mintInfo, TOKEN_PROGRAM_ID);
    expect(mint.mintAuthority?.equals(market)).toBe(true);
    expect(mint.freezeAuthority).toBeNull();
    expect(mint.decimals).toBe(state.decimals[c]!);
    expect(mint.address.equals(state.mints[asset]!)).toBe(true);
    supplies.set(asset, mint.supply);
    const vaultInfo = accounts[1 + index]!;
    const vault = unpackAccount(addresses[1 + index]!, vaultInfo, vaultInfo.owner);
    expect(vault.owner.equals(market)).toBe(true);
    expect(vault.mint.equals(state.mints[asset]!)).toBe(true);
    expect(big(state.credits[asset]!)).toBe(credits(asset));
    expect(big(state.escrow[asset]!)).toBe(escrow(asset));
    expect(vault.amount).toBeGreaterThanOrEqual(credits(asset) + escrow(asset) + big(state.fees[asset]!));
    expect(mint.supply).toBeGreaterThanOrEqual(vault.amount);
  }
  for (const c of collaterals) {
    const underlying = underlyingAsset(c);
    // Underlying credit never persists in a market: it lives in AssetCredit.
    expect(big(state.credits[underlying]!)).toBe(0n);
    expect(credits(underlying)).toBe(0n);
    expect(big(state.escrow[underlying]!)).toBe(escrow(underlying));
    const yes = supplies.get(claimAsset(c, 0))!,
      no = supplies.get(claimAsset(c, 1))!;
    let potential = yes > no ? yes : no;
    if ([6, 7].includes(state.state)) {
      const y = BigInt(state.payouts[0]!),
        n = BigInt(state.payouts[1]!);
      expect(y + n).toBeGreaterThan(0n);
      // A conservative CEILING also covers merge after INVALID resolution.
      potential = (yes * y + no * n + y + n - 1n) / (y + n);
    }
    const backing = big(state.backing[c]!);
    expect(backing).toBeGreaterThanOrEqual(potential);
    const poolInfo = accounts[poolStart + 2 * c]!,
      vaultInfo = accounts[poolStart + 2 * c + 1]!;
    expect(poolInfo.owner.equals(program)).toBe(true);
    const pool = coder.accounts.decode("AssetPool", poolInfo.data) as AssetPoolAccount;
    expect(pool.mint.equals(state.mints[underlying]!)).toBe(true);
    const poolVault = unpackAccount(addresses[poolStart + 2 * c + 1]!, vaultInfo, vaultInfo.owner);
    expect(vaultInfo.owner.equals(pool.token_program)).toBe(true);
    expect(poolVault.amount).toBeGreaterThanOrEqual(big(pool.liability));
    expect(big(pool.liability)).toBeGreaterThanOrEqual(big(state.escrow[underlying]!) + backing);
  }
  for (const asset of [0, 1, 2, 3].flatMap((c) => (c > listed ? [3 * c, 3 * c + 1, 3 * c + 2] : [])))
    expect([state.credits[asset], state.escrow[asset], state.fees[asset]].map((v) => big(v!))).toEqual([0n, 0n, 0n]);
  expect(big(state.open_notional)).toBe(orders.reduce((sum, o) => sum + big(o.open_notional), 0n));
  for (const wallet of wallets)
    expect(big(wallet.open_notional)).toBe(
      orders.reduce((sum, o) => sum + (o.owner.equals(wallet.owner) ? big(o.open_notional) : 0n), 0n),
    );
  return state;
}
