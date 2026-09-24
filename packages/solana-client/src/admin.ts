import { canonicalStringify } from "@conditional-stocks/market-data";
import { decodeSupportedMint, ALL_ISSUER_CONTROLS, issuerState } from "./tokens.ts";
import {
  SolanaClient,
  envelope,
  type Deployment,
  type Envelope,
  wireInstruction,
} from "./transactions.ts";
import { PublicKey } from "@solana/web3.js";
import {
  key,
  digest,
  bytes32,
  marketAddress,
  bn,
  resolutionHash,
  SystemProgram,
  claimAddress,
  vaultAddress,
  poolAddress, poolVaultAddress,
  TOKEN_PROGRAM_ID,
  COLLATERALS,
  MAX_BASES,
  QUOTE,
  claimAsset,
  underlyingAsset,
  type AssetPoolAccount,
  type MarketAccount,
  coder,
} from "./protocol.ts";
import {
  assertEvidenceIntegrity,
  type CreationEvidencePacket,
  type ResolutionEvidencePacket,
  type EvidenceEnvelope,
  type EvidenceDeployment,
} from "./evidence.ts";

export type AdminAction =
  | "create-market"
  | "begin-resolution"
  | "resolve-market";
/** Stable market identity: the canonical creation config, including its
 * ordered issuer-token list. */
export const marketIdFromConfig = (config: CreationEvidencePacket["config"]) =>
  digest("PROBABL_SOLANA_MARKET_V1:" + canonicalStringify(config));
export interface AdminTransaction extends Envelope {
  from: string;
  chainId: 1;
}
export interface AdminPreview extends AdminTransaction {
  action: AdminAction;
  expectedMarketId: string;
  packetHash: string;
  previewId: string;
}
export type PacketEnvelope = EvidenceEnvelope<
  CreationEvidencePacket | ResolutionEvidencePacket
>;
export type AdminDeployment = Deployment &
  EvidenceDeployment & { marketAdmin: string; resolutionAdmin: string };

export function evidenceTransaction(
  value: PacketEnvelope,
  action: AdminAction,
  deployment: AdminDeployment,
): AdminTransaction & { expectedMarketId: string } {
  assertEvidenceIntegrity(value);
  const p = value.packet,
    d = p.deployment;
  if (
    d.config !== deployment.config ||
    d.programId !== deployment.programId ||
    d.genesisHash !== deployment.genesisHash
  )
    throw new Error("Evidence belongs to another Solana deployment");
  const client = new SolanaClient(deployment);
  let expectedMarketId: string, from: string, ix;
  if (p.kind === "market-creation") {
    if (action !== "create-market")
      throw new Error("Action does not match the evidence packet");
    const c = p.config,
      id = marketIdFromConfig(c),
      market = marketAddress(client.config, id, client.program);
    expectedMarketId = market.toBase58();
    from = deployment.marketAdmin;
    const terms = {
      condition: [...bytes32(c.polymarketConditionId)],
      yes_index: Number(c.polymarketYesIndex),
      no_index: Number(c.polymarketNoIndex),
      rules_hash: [...bytes32(c.rulesHash)],
      metadata_hash: [...bytes32(c.metadataHash)],
      metadata_uri: c.metadataUri,
      trading_open: bn(c.tradingOpen),
      trading_cutoff: bn(c.tradingCutoff),
      share_decimals: Number(c.shareDecimals),
      tick: bn(c.priceTickRawX18),
      step: bn(c.baseStep),
      min_notional: bn(c.minNotional),
      max_quantity: bn(c.maxOrderQuantity),
      max_order: bn(c.maxOrderNotional),
      max_wallet: bn(c.maxWalletOpenNotional),
      max_market: bn(c.maxMarketOpenNotional),
    };
    // The market lists the quote only; `initializeMarketVaults` then lists the
    // evidence's issuer tokens (add_base) and creates every claim mint.
    const quotePool = poolAddress(client.config, key(c.quoteToken), client.program);
    ix = client.ix(
      "create_market",
      { id: [...id], terms },
      {
        admin: key(from),
        config: client.config,
        market,
        quote_mint: key(c.quoteToken),
        quote_pool: quotePool,
        quote_vault: poolVaultAddress(quotePool, client.program),
        system_program: SystemProgram.programId,
      },
    );
  } else {
    expectedMarketId = p.localMarket.marketId;
    const market = key(expectedMarketId),
      yes = Number(p.payout.yes),
      no = Number(p.payout.no),
      evidence = bytes32(value.packetHash);
    if (action === "begin-resolution") {
      from = deployment.marketAdmin;
      ix = client.ix(
        "lifecycle",
        {
          action: 3,
          commitment: [
            ...resolutionHash(
              client.config,
              market,
              yes,
              no,
              evidence,
              p.sourceReference,
              client.program,
            ),
          ],
        },
        { actor: key(from), config: client.config, market },
      );
    } else if (action === "resolve-market") {
      from = deployment.resolutionAdmin;
      ix = client.ix(
        "resolve",
        { yes, no, evidence: [...evidence], uri: p.sourceReference },
        // The resolver pays the rent for the evidence URI bytes it adds.
        { actor: key(from), config: client.config, market, system_program: SystemProgram.programId },
      );
    } else throw new Error("Action does not match the evidence packet");
  }
  return {
    ...envelope([ix], client.program),
    from,
    chainId: 1,
    expectedMarketId,
  };
}

export function lifecycleTransaction(
  deployment: Deployment,
  owner: string,
  marketId: string,
  action: 0 | 1 | 2 | 4,
  reason = "",
): AdminTransaction {
  if ([1, 4].includes(action) && !reason.trim())
    throw new Error("A non-empty reason is required");
  const client = new SolanaClient(deployment);
  return {
    ...envelope(
      [
        client.ix(
          "lifecycle",
          {
            action,
            commitment: [...(reason ? digest(reason) : new Uint8Array(32))],
          },
          { actor: key(owner), config: client.config, market: key(marketId) },
        ),
      ],
      client.program,
    ),
    from: owner,
    chainId: 1,
  };
}

/** Admission bits a pool needs for a mint: exactly its issuer controls. */
export async function mintAdmission(client: SolanaClient, mint: PublicKey) {
  const info = await client.connection.getAccountInfo(mint, "confirmed");
  const decoded = decodeSupportedMint(mint, info, ALL_ISSUER_CONTROLS);
  return { program: decoded.program, admitted: decoded.issuer.controls, issuer: decoded.issuer, decimals: decoded.decimals };
}

async function existingPool(client: SolanaClient, mint: PublicKey): Promise<AssetPoolAccount | null> {
  const info = await client.connection.getAccountInfo(poolAddress(client.config, mint, client.program), "confirmed");
  if (!info) return null;
  if (!info.owner.equals(client.program)) throw new Error("Pool address is not owned by the program");
  return coder.accounts.decode("AssetPool", info.data) as AssetPoolAccount;
}

/** List one issuer token as the market's next base leg: creates its custody
 * pool first (admitting exactly the mint's issuer controls) when missing. */
export async function addBaseInstructions(client: SolanaClient, market: PublicKey, admin: PublicKey, mint: PublicKey) {
  const { program, admitted } = await mintAdmission(client, mint);
  const pool = poolAddress(client.config, mint, client.program);
  const current = await existingPool(client, mint);
  if (current && current.admitted !== admitted)
    throw new Error(`Pool admits issuer controls ${current.admitted} but the mint now uses ${admitted}; issuer configuration changed`);
  return [
    ...(current ? [] : [client.initializePool(mint, admin, program, admitted)]),
    client.ix("add_base", {}, {
      admin, config: client.config, market, mint, pool,
      vault: poolVaultAddress(pool, client.program), token_program: program,
    }),
  ];
}

export function initializeClaimsInstruction(client: SolanaClient, market: PublicKey, payer: PublicKey, collateral: number) {
  if (!Number.isInteger(collateral) || collateral < 0 || collateral >= COLLATERALS) throw new Error("Invalid collateral");
  const yes = claimAsset(collateral, 0), no = claimAsset(collateral, 1);
  return client.ix("initialize_claims", { collateral }, {
    payer, market,
    yes_mint: claimAddress(market, yes, client.program),
    no_mint: claimAddress(market, no, client.program),
    yes_vault: vaultAddress(market, yes, client.program),
    no_vault: vaultAddress(market, no, client.program),
    token_program: TOKEN_PROGRAM_ID,
    system_program: SystemProgram.programId,
  });
}

/** Everything a created market still needs before it can open, in order:
 * list each issuer token (pool + add_base) not yet listed, then create the
 * claim mints of every collateral. `baseTokens` is the evidence's ordered list;
 * already-listed legs must match it exactly. */
export async function initializeMarketVaults(
  client: SolanaClient,
  marketId: string,
  payer: string,
  baseTokens: readonly string[] = [],
): Promise<AdminTransaction[]> {
  const market = key(marketId),
    m = await client.market(market),
    admin = key(payer),
    result: AdminTransaction[] = [];
  if (baseTokens.length > MAX_BASES || new Set(baseTokens).size !== baseTokens.length)
    throw new Error(`A market lists 1-${MAX_BASES} distinct issuer tokens`);
  for (let c = 1; c <= m.bases; c++)
    if (baseTokens.length && m.mints[underlyingAsset(c)]!.toBase58() !== baseTokens[c - 1])
      throw new Error("Listed issuer legs differ from the market evidence");
  const tx = (instructions: ReturnType<SolanaClient["ix"]>[]) => ({
    ...envelope(instructions, client.program), from: payer, chainId: 1 as const,
  });
  for (const [index, token] of baseTokens.entries())
    if (index + 1 > m.bases) result.push(tx(await addBaseInstructions(client, market, admin, key(token))));
  const listed = Math.max(m.bases, baseTokens.length);
  for (let c = QUOTE; c <= listed; c++) {
    const bits = (1 << claimAsset(c, 0)) | (1 << claimAsset(c, 1));
    if ((m.vaults_initialized & bits) !== bits) result.push(tx([initializeClaimsInstruction(client, market, admin, c)]));
  }
  return result;
}

/** Delist (guardian or market admin) or relist (market admin) a base leg. */
export function setBaseTransaction(
  deployment: Deployment,
  actor: string,
  marketId: string,
  collateral: number,
  active: boolean,
): AdminTransaction {
  if (!Number.isInteger(collateral) || collateral < 1 || collateral > MAX_BASES) throw new Error("Invalid base leg");
  const client = new SolanaClient(deployment);
  return {
    ...envelope([client.ix("set_base", { collateral, active }, { actor: key(actor), config: client.config, market: key(marketId) })], client.program),
    from: actor,
    chainId: 1,
  };
}

/** Whitelist an additional issuer token on an existing market. */
export async function addBaseTransaction(client: SolanaClient, marketId: string, admin: string, mint: string): Promise<AdminTransaction[]> {
  const market = key(marketId), m = await client.market(market);
  if (m.bases >= MAX_BASES) throw new Error(`Markets list at most ${MAX_BASES} issuer tokens`);
  for (let c = 0; c <= m.bases; c++)
    if (m.mints[underlyingAsset(c)]!.toBase58() === mint) throw new Error("Token is already listed on this market");
  const listing = await addBaseInstructions(client, market, key(admin), key(mint));
  return [
    { ...envelope(listing, client.program), from: admin, chainId: 1 },
    { ...envelope([initializeClaimsInstruction(client, market, key(admin), m.bases + 1)], client.program), from: admin, chainId: 1 },
  ];
}

export type { MarketAccount };
export { issuerState };

export async function preflightAdmin(
  client: SolanaClient,
  transaction: AdminTransaction,
) {
  if (
    transaction.chainId !== 1 ||
    transaction.to !== client.program.toBase58() ||
    transaction.value !== "0"
  )
    throw new Error("Invalid admin deployment");
  const account = await client.connection.getAccountInfo(client.program);
  if (!account?.executable)
    throw new Error("The Solana program is not deployed");
  const built = await client.prepareTransaction(
    key(transaction.from),
    transaction,
    { pinWalletFees: true },
  );
  const response = await client.connection.simulateTransaction(
    built.transaction,
    {
      sigVerify: false,
      commitment: "confirmed",
    },
  );
  if (response.value.err)
    throw new Error(
      "Admin simulation failed: " + JSON.stringify(response.value.err),
    );
  return built;
}

export { wireInstruction };
