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
  // Market + four conditional vaults + four claim mints = 9 accounts, 99/read.
  const markets = [...s.markets.keys()].map(key);
  const width = 9;
  for (let start = 0; start < markets.length; start += 11) {
    const group = markets.slice(start, start + 11);
    const addresses = group.flatMap((m) => [
      m,
      ...Array.from({ length: 4 }, (_, a) => vaultAddress(m, a + 2, client.program)),
      ...Array.from({ length: 4 }, (_, a) => claimAddress(m, a + 2, client.program)),
    ]);
    const infos = await read(addresses);
    for (let i = 0; i < group.length; i++) {
      const info = infos[i * width];
      if (!info?.owner.equals(client.program))
        throw new Error("Reconciliation market account is missing or foreign");
      const market = coder.accounts.decode("Market", info.data) as MarketAccount;
      if (!market.config.equals(client.config))
        throw new Error("Reconciliation deployment mismatch");
      if (![1, 2, 3, 4, 6, 7].includes(market.state) || market.vaults_initialized > 63)
        throw new Error("Invalid market lifecycle or initialization mask");
      if (big(market.credits[0]!) || big(market.credits[1]!))
        throw new Error("Persisted market underlying credit");
      const supply = [0n, 0n, 0n, 0n];
      for (let claim = 0; claim < 4; claim++) {
        const asset = claim + 2;
        const liability =
          big(market.credits[asset]!) + big(market.escrow[asset]!) + big(market.fees[claim]!);
        if (!(market.vaults_initialized & (1 << asset))) {
          if (liability) throw new Error("Uninitialized vault has liabilities");
          continue;
        }
        const vaultInfo = infos[i * width + 1 + claim];
        if (!vaultInfo?.owner.equals(TOKEN_PROGRAM_ID))
          throw new Error("Protocol claim vault missing or foreign");
        const vault = unpackAccount(addresses[i * width + 1 + claim]!, vaultInfo, TOKEN_PROGRAM_ID);
        assertVault(vault, group[i]!, market.mints[asset]!, liability);
        checked++;
        const mintAddress = addresses[i * width + 5 + claim]!;
        if (!market.mints[asset]!.equals(mintAddress))
          throw new Error("Registered claim mint is not the canonical PDA");
        const mintInfo = infos[i * width + 5 + claim];
        if (!mintInfo?.owner.equals(TOKEN_PROGRAM_ID))
          throw new Error("Claim mint is missing or has a foreign token program");
        const mint = unpackMint(mintAddress, mintInfo, TOKEN_PROGRAM_ID);
        if (
          !mint.isInitialized ||
          !mint.mintAuthority?.equals(group[i]!) ||
          mint.freezeAuthority ||
          mint.decimals !== market.decimals[Math.floor(claim / 2)]
        )
          throw new Error("Claim mint authorities or decimals differ from market");
        if (mint.supply < vault.amount) throw new Error("Claim custody exceeds total mint supply");
        supply[claim] = mint.supply;
        checkedMints++;
      }
      for (let collateral = 0; collateral < 2; collateral++) {
        const required = requiredClaimBacking(
          supply[2 * collateral]!,
          supply[2 * collateral + 1]!,
          [6, 7].includes(market.state) ? market.payouts : undefined,
        );
        if (big(market.backing[collateral]!) < required)
          throw new Error(
            "Conditional backing does not cover outstanding claim supply: " + group[i],
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
