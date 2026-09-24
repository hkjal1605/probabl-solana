import { unpackAccount, unpackMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  SolanaClient,
  key,
  coder,
  big,
  vaultAddress,
  poolAddress,
  poolVaultAddress,
  type MarketAccount,
  type AssetPoolAccount,
  tokenProgram,
  claimAddress,
  requiredClaimBacking,
  ASSETS,
  MAX_BASES,
  claimAsset,
  isClaimAsset,
  underlyingAsset,
} from "@conditional-stocks/solana-client";
import type { Snapshot } from "./projection";
import { reconcileLedger } from "./custody";

/** Ledger totals use one program snapshot. Each external custody comparison
 * re-reads its liability account alongside tokens in a single finalized bank.
 * Never compare a cached liability to token balances from a later bank. */
export async function reconcileVaults(client: SolanaClient, s: Snapshot) {
  const ledger = reconcileLedger(s);
  let slot = s.slot,
    checked = 0,
    checkedMints = 0;
  const read = async (addresses: ReturnType<typeof key>[]) => {
    const response = await client.connection.getMultipleAccountsInfoAndContext(addresses, {
      commitment: "finalized",
      minContextSlot: s.slot,
    });
    if (
      response.value.length !== addresses.length ||
      !Number.isSafeInteger(response.context.slot) ||
      response.context.slot < s.slot
    )
      throw new Error("Incomplete finalized custody read");
    slot = Math.max(slot, response.context.slot);
    return response.value;
  };
  const assertVault = (
    vault: ReturnType<typeof unpackAccount>,
    authority: ReturnType<typeof key>,
    mint: ReturnType<typeof key>,
    liability: bigint,
  ) => {
    if (!vault.owner.equals(authority) || !vault.mint.equals(mint))
      throw new Error("Vault authority or mint mismatch");
    if (vault.isFrozen || !vault.isInitialized || vault.delegate || vault.closeAuthority)
      throw new Error("Vault is frozen, uninitialized or has unexpected token authorities");
    if (vault.amount < liability) throw new Error("Vault is undercollateralized: " + vault.address);
  };
  // Pool counted once, irrespective of how many markets use this mint.
  const pools = [...s.pools.keys()].map(key);
  for (let start = 0; start < pools.length; start += 50) {
    const group = pools.slice(start, start + 50);
    const addresses = group.flatMap((pool) => [pool, poolVaultAddress(pool, client.program)]);
    const infos = await read(addresses);
    for (let i = 0; i < group.length; i++) {
      const info = infos[i * 2],
        vaultInfo = infos[i * 2 + 1];
      if (!info?.owner.equals(client.program) || !vaultInfo)
        throw new Error("Missing or foreign pool custody");
      const pool = coder.accounts.decode("AssetPool", info.data) as AssetPoolAccount;
      if (
        !pool.config.equals(client.config) ||
        !poolAddress(client.config, pool.mint, client.program).equals(group[i]!)
      )
        throw new Error("Pool deployment identity mismatch");
      const program = tokenProgram(pool.token_program);
      const vault = unpackAccount(addresses[i * 2 + 1]!, vaultInfo, program);
      assertVault(vault, group[i]!, pool.mint, big(pool.liability));
      checked++;
    }
  }
  // Per market: the market, then for each listed collateral (quote and every
  // issuer leg) its YES/NO claim vaults and YES/NO claim mints. Groups of whole
  // markets never exceed 100 accounts per read.
  const layouts = [...s.markets].map(([id, m]) => {
    const collaterals = Array.from({ length: m.bases + 1 }, (_, c) => c);
    const market = key(id);
    return {
      market,
      collaterals,
      addresses: [
        market,
        ...collaterals.flatMap((c) =>
          [0, 1].flatMap((branch) => {
            const asset = claimAsset(c, branch);
            return [
              vaultAddress(market, asset, client.program),
              claimAddress(market, asset, client.program),
            ];
          }),
        ),
      ],
    };
  });
  const groups: (typeof layouts)[] = [];
  for (const layout of layouts) {
    const last = groups.at(-1);
    if (last && last.reduce((n, l) => n + l.addresses.length, 0) + layout.addresses.length <= 100)
      last.push(layout);
    else groups.push([layout]);
  }
  for (const group of groups) {
    const infos = await read(group.flatMap((l) => l.addresses));
    let offset = 0;
    for (const layout of group) {
      const at = offset;
      offset += layout.addresses.length;
      const info = infos[at];
      if (!info?.owner.equals(client.program))
        throw new Error("Reconciliation market account is missing or foreign");
      const market = coder.accounts.decode("Market", info.data) as MarketAccount;
      if (!market.config.equals(client.config))
        throw new Error("Reconciliation deployment mismatch");
      if (
        ![1, 2, 3, 4, 6, 7].includes(market.state) ||
        market.vaults_initialized >= 1 << ASSETS ||
        market.bases > MAX_BASES ||
        market.vaults_initialized >> (3 * (market.bases + 1)) !== 0 ||
        market.mints.length !== ASSETS ||
        market.credits.length !== ASSETS ||
        market.escrow.length !== ASSETS ||
        market.fees.length !== ASSETS
      )
        throw new Error("Invalid market lifecycle, legs or initialization mask");
      // A leg listed after the program snapshot is reconciled on the next pass.
      if (market.bases + 1 !== layout.collaterals.length)
        throw new Error("Market listing changed during reconciliation");
      for (let asset = 0; asset < ASSETS; asset++)
        if (!isClaimAsset(asset) && big(market.credits[asset]!))
          throw new Error("Persisted market underlying credit");
      for (const c of layout.collaterals) {
        const underlying = underlyingAsset(c);
        if (market.vaults_initialized & (1 << underlying)) {
          // Leg custody is the protocol pool of exactly the listed mint, with
          // the market's recorded decimals.
          const pool = s.pools.get(
            poolAddress(client.config, market.mints[underlying]!, client.program).toBase58(),
          );
          if (!pool || pool.decimals !== market.decimals[c])
            throw new Error("Listed collateral pool is missing or has different decimals");
        }
        const supply = [0n, 0n];
        for (const branch of [0, 1]) {
          const asset = claimAsset(c, branch);
          const liability =
            big(market.credits[asset]!) + big(market.escrow[asset]!) + big(market.fees[asset]!);
          if (!(market.vaults_initialized & (1 << asset))) {
            if (liability) throw new Error("Uninitialized vault has liabilities");
            continue;
          }
          const index = at + 1 + 4 * c + 2 * branch;
          const vaultInfo = infos[index];
          if (!vaultInfo?.owner.equals(TOKEN_PROGRAM_ID))
            throw new Error("Protocol claim vault missing or foreign");
          const vaultAddressKey = layout.addresses[1 + 4 * c + 2 * branch]!;
          const vault = unpackAccount(vaultAddressKey, vaultInfo, TOKEN_PROGRAM_ID);
          assertVault(vault, layout.market, market.mints[asset]!, liability);
          checked++;
          const mintAddress = layout.addresses[2 + 4 * c + 2 * branch]!;
          if (!market.mints[asset]!.equals(mintAddress))
            throw new Error("Registered claim mint is not the canonical PDA");
          const mintInfo = infos[index + 1];
          if (!mintInfo?.owner.equals(TOKEN_PROGRAM_ID))
            throw new Error("Claim mint is missing or has a foreign token program");
          const mint = unpackMint(mintAddress, mintInfo, TOKEN_PROGRAM_ID);
          if (
            !mint.isInitialized ||
            !mint.mintAuthority?.equals(layout.market) ||
            mint.freezeAuthority ||
            mint.decimals !== market.decimals[c]
          )
            throw new Error("Claim mint authorities or decimals differ from market");
          if (mint.supply < vault.amount) throw new Error("Claim custody exceeds total mint supply");
          supply[branch] = mint.supply;
          checkedMints++;
        }
        const required = requiredClaimBacking(
          supply[0]!,
          supply[1]!,
          [6, 7].includes(market.state) ? market.payouts : undefined,
        );
        if (big(market.backing[c]!) < required)
          throw new Error(
            "Conditional backing does not cover outstanding claim supply: " + layout.market,
          );
      }
    }
  }
  return {
    healthy: true,
    checkedVaults: checked,
    checkedMints,
    ledger,
    slot: String(slot),
    checkedAt: new Date().toISOString(),
  };
}
