import { unpackAccount, unpackMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  SolanaClient,
  key,
  coder,
  big,
  vaultAddress,
  type MarketAccount,
  tokenProgram,
  claimAddress,
  requiredClaimBacking,
} from "@conditional-stocks/solana-client";

export async function reconcileVaults(
  client: SolanaClient,
  markets: string[],
  minimumSlot: number,
) {
  let slot = minimumSlot,
    checked = 0,
    checkedMints = 0;
  // 11 accounts per market, at most 99 per RPC request. Supplies MUST be from
  // the SAME finalized bank as backing/custody; externally held claims count too.
  const width = 11;
  // Read each market and its custody accounts in the SAME RPC bank snapshot.
  // Comparing old projected liabilities against newer token balances is unsound.
  for (let start = 0; start < markets.length; start += 9) {
    const group = markets.slice(start, start + 9).map(key),
      addresses = group.flatMap((m) => [
        m,
        ...Array.from({ length: 6 }, (_, a) =>
          vaultAddress(m, a, client.program),
        ),
        ...Array.from({ length: 4 }, (_, a) =>
          claimAddress(m, a + 2, client.program),
        ),
      ]);
    const result = await client.connection.getMultipleAccountsInfoAndContext(
      addresses,
      {
        commitment: "finalized",
        minContextSlot: minimumSlot,
      },
    );
    slot = Math.max(slot, result.context.slot);
    for (let i = 0; i < group.length; i++) {
      const info = result.value[i * width];
      if (!info?.owner.equals(client.program))
        throw new Error("Reconciliation market account is missing or foreign");
      const market = coder.accounts.decode(
        "Market",
        info.data,
      ) as MarketAccount;
      if (!market.config.equals(client.config))
        throw new Error("Reconciliation deployment mismatch");
      if (
        ![1, 2, 3, 4, 6, 7].includes(market.state) ||
        market.vaults_initialized > 63
      )
        throw new Error("Invalid market lifecycle or initialization mask");
      const supply = [0n, 0n, 0n, 0n];
      const claimBalances = [0n, 0n, 0n, 0n];
      for (let asset = 0; asset < 6; asset++) {
        const liability =
          big(market.credits[asset]!) +
          big(market.escrow[asset]!) +
          big(asset < 2 ? market.backing[asset]! : market.fees[asset - 2]!);
        if (!(market.vaults_initialized & (1 << asset))) {
          if (liability !== 0n)
            throw new Error("Uninitialized vault has liabilities");
          continue;
        }
        const vaultInfo = result.value[i * width + 1 + asset];
        if (!vaultInfo) throw new Error("Initialized vault is missing");
        const program = tokenProgram(vaultInfo.owner);
        if (asset >= 2 && !program.equals(TOKEN_PROGRAM_ID))
          throw new Error(
            "Protocol claim vault must use the classic token program",
          );
        const vault = unpackAccount(
          addresses[i * width + 1 + asset]!,
          vaultInfo,
          program,
        );
        if (
          !vault.owner.equals(group[i]!) ||
          !vault.mint.equals(market.mints[asset]!)
        )
          throw new Error("Vault authority or mint differs from its market");
        if (
          vault.isFrozen ||
          !vault.isInitialized ||
          vault.delegate ||
          vault.closeAuthority
        )
          throw new Error(
            "Vault is frozen, uninitialized or has unexpected token authorities",
          );
        if (vault.amount < liability)
          throw new Error(
            "Vault is undercollateralized: " + vault.address.toBase58(),
          );
        if (asset >= 2) claimBalances[asset - 2] = vault.amount;
        checked++;
      }
      for (let claim = 0; claim < 4; claim++) {
        const asset = claim + 2;
        if (!(market.vaults_initialized & (1 << asset))) continue;
        const address = addresses[i * width + 7 + claim]!;
        if (!market.mints[asset]!.equals(address))
          throw new Error("Registered claim mint is not the canonical PDA");
        const mintInfo = result.value[i * width + 7 + claim];
        if (!mintInfo?.owner.equals(TOKEN_PROGRAM_ID))
          throw new Error(
            "Claim mint is missing or has a foreign token program",
          );
        const mint = unpackMint(address, mintInfo, TOKEN_PROGRAM_ID);
        if (
          !mint.isInitialized ||
          !mint.mintAuthority?.equals(group[i]!) ||
          mint.freezeAuthority ||
          mint.decimals !== market.decimals[Math.floor(claim / 2)]
        )
          throw new Error(
            "Claim mint authorities or decimals differ from market",
          );
        if (mint.supply < claimBalances[claim]!)
          throw new Error("Claim custody exceeds total mint supply");
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
            "Conditional backing does not cover outstanding claim supply: " +
              group[i]!.toBase58(),
          );
      }
    }
  }
  return {
    healthy: true,
    checkedVaults: checked,
    checkedMints,
    slot: String(slot),
    checkedAt: new Date().toISOString(),
  };
}
