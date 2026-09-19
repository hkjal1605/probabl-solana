import { canonicalStringify } from "@conditional-stocks/market-data";
import { supportedMint } from "./tokens.ts";
import {
  SolanaClient,
  envelope,
  type Deployment,
  type Envelope,
  wireInstruction,
} from "./transactions.ts";
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
      id = digest("PROBABL_SOLANA_MARKET_V1:" + canonicalStringify(c)),
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
      tick: bn(c.priceTickRawX18),
      step: bn(c.baseStep),
      min_notional: bn(c.minNotional),
      max_quantity: bn(c.maxOrderQuantity),
      max_order: bn(c.maxOrderNotional),
      max_wallet: bn(c.maxWalletOpenNotional),
      max_market: bn(c.maxMarketOpenNotional),
    };
    ix = client.ix(
      "create_market",
      { id: [...id], terms },
      {
        admin: key(from),
        config: client.config,
        market,
        base_mint: key(c.baseToken),
        quote_mint: key(c.quoteToken),
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
        { actor: key(from), config: client.config, market },
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

export async function initializeMarketVaults(
  client: SolanaClient,
  marketId: string,
  payer: string,
): Promise<AdminTransaction[]> {
  const market = key(marketId),
    m = await client.market(market),
    result: AdminTransaction[] = [];
  for (let asset = 0; asset < 6; asset++)
    if (!(m.vaults_initialized & (1 << asset))) {
      const mint = m.mints[asset]!;
      const pool = asset < 2 ? poolAddress(client.config, mint, client.program) : null;
      const tokenProgram = asset < 2 ? (await supportedMint(client.connection, mint)).program : TOKEN_PROGRAM_ID;
      const initialize = pool && !(await client.connection.getAccountInfo(pool)) ? [client.initializePool(mint, key(payer), tokenProgram)] : [];
      result.push({
        ...envelope(
          [
            ...initialize,
            client.ix(
              asset < 2 ? "initialize_asset" : "initialize_claim",
              { asset },
              {
                payer: key(payer),
                market,
                mint:
                  asset < 2
                    ? m.mints[asset]!
                    : claimAddress(market, asset, client.program),
                ...(pool ? { pool } : {}),
                vault: pool ? poolVaultAddress(pool, client.program) : vaultAddress(market, asset, client.program),
                token_program: tokenProgram,
                system_program: SystemProgram.programId,
              },
            ),
          ],
          client.program,
        ),
        from: payer,
        chainId: 1,
      });
    }
  return result;
}

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
