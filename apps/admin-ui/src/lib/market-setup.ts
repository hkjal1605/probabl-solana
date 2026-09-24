import {
  claimAsset,
  coder,
  key,
  type LiveLeg,
  legAccounts,
  legStates,
  MAX_BASES,
  type MarketAccount,
  marketAddress,
  multiplierValue,
  type SolanaClient,
  underlyingAsset,
  unwrap,
} from "@conditional-stocks/solana-client";
import {
  type AdminDeployment,
  type AdminTransaction,
  addBaseTransaction,
  initializeMarketVaults,
  marketIdFromConfig,
  setBaseTransaction,
} from "@conditional-stocks/solana-client/admin";
import type { EvidenceView } from "./admin-api";
import { accountsInfo, checkIssuerMints, issuerLegProblems, mintMetadata } from "./issuer-mints";

/** One wallet signature in an ordered setup sequence. */
export interface SetupStep {
  title: string;
  details: string[];
  transaction: AdminTransaction;
}

const ADMISSION = [
  "permanentDelegate",
  "pausable",
  "defaultAccountState",
  "scaledUiAmount",
  "transferHook",
  "confidentialTransfer",
];

/** Human description of an admin transaction's program instructions, decoded locally. */
export function describeAdminTransaction(
  transaction: AdminTransaction,
  program: string,
  names: Record<string, string> = {},
): string[] {
  const label = (address: string) => names[address] ?? address;
  return unwrap(transaction, key(program)).flatMap((ix) => {
    if (!ix.programId.equals(key(program))) return [];
    const decoded = coder.instruction.decode(ix.data);
    if (!decoded) return ["Unknown program instruction"];
    const data = decoded.data as Record<string, unknown>;
    const accounts = ix.keys.map((meta) => meta.pubkey.toBase58());
    const known = accounts.find((address) => names[address]);
    switch (decoded.name) {
      case "initialize_pool": {
        const admitted = Number(data.admitted);
        const controls = ADMISSION.filter((_, bit) => admitted & (1 << bit));
        return [
          `Create protocol custody pool for ${known ? label(known) : accounts[2]} admitting issuer controls ${admitted}${controls.length ? ` (${controls.join(", ")})` : ""}`,
        ];
      }
      case "add_base":
        return [`List ${known ? label(known) : accounts[3]} as the next issuer leg (add_base)`];
      case "initialize_claims": {
        const collateral = Number(data.collateral);
        return [
          collateral === 0
            ? "Create the quote YES/NO claim mints and vaults (initialize_claims 0)"
            : `Create leg ${collateral} YES/NO claim mints and vaults (initialize_claims ${collateral})`,
        ];
      }
      case "set_base":
        return [
          `${data.active ? "Relist" : "Delist"} issuer leg ${Number(data.collateral)} (set_base)`,
        ];
      default:
        return [decoded.name.replaceAll("_", " ")];
    }
  });
}

const stepTitle = (details: string[]) =>
  details.some((d) => d.includes("add_base"))
    ? "List issuer token"
    : details.some((d) => d.includes("initialize_claims"))
      ? "Create claim mints"
      : details.some((d) => d.includes("set_base"))
        ? "Change leg listing"
        : "Admin transaction";

export const toSteps = (
  transactions: AdminTransaction[],
  program: string,
  names: Record<string, string> = {},
): SetupStep[] =>
  transactions.map((transaction) => {
    const details = describeAdminTransaction(transaction, program, names);
    return { title: stepTitle(details), details, transaction };
  });

/** Remaining listing (pool + add_base per issuer, in evidence order) and claim steps before open. */
export async function marketSetupSteps(
  client: SolanaClient,
  marketId: string,
  payer: string,
  baseTokens: readonly string[],
  names: Record<string, string> = {},
) {
  return toSteps(
    await initializeMarketVaults(client, marketId, payer, baseTokens),
    client.program.toBase58(),
    names,
  );
}

/** The ordered issuer tokens of the (single) non-rejected creation packet for this market. */
export function creationBaseTokens(
  packets: EvidenceView[],
  marketId: string,
  deployment: Pick<AdminDeployment, "config" | "programId">,
): string[] | null {
  const matches = packets.filter((view) => {
    const packet = view.envelope.packet;
    if (packet.kind !== "market-creation" || view.status === "rejected") return false;
    try {
      return (
        marketAddress(
          key(deployment.config),
          marketIdFromConfig(packet.config),
          key(deployment.programId),
        ).toBase58() === marketId
      );
    } catch {
      return false;
    }
  });
  const lists = new Set(
    matches.map((view) =>
      view.envelope.packet.kind === "market-creation"
        ? JSON.stringify(view.envelope.packet.config.baseTokens)
        : "",
    ),
  );
  if (lists.size !== 1) return null;
  return JSON.parse([...lists][0]!) as string[];
}

/** What a created market still lacks before it can open (evidence-ordered issuer legs + claim mints). */
export function setupRemaining(market: MarketAccount, baseTokens: readonly string[]) {
  const listed = Math.max(market.bases, baseTokens.length);
  const missingLegs = Math.max(0, baseTokens.length - market.bases);
  let missingClaims = 0;
  for (let c = 0; c <= listed; c++) {
    const bits = (1 << claimAsset(c, 0)) | (1 << claimAsset(c, 1));
    if ((market.vaults_initialized & bits) !== bits) missingClaims++;
  }
  return {
    missingLegs,
    missingClaims,
    complete: listed > 0 && missingLegs === 0 && missingClaims === 0,
  };
}

export const HALT_TEXT: Record<NonNullable<LiveLeg["halt"]>, string> = {
  delisted: "Delisted by governance",
  "claims-uninitialized": "Claim mints not initialized",
  "issuer-paused": "Issuer paused the token",
  "vault-frozen": "Protocol pool vault is frozen by the issuer",
  "corporate-action": "Multiplier left the ±20–25% dividend band (split or corporate action)",
  "transfer-hook": "Issuer configured a transfer hook",
  unreadable: "Mint or pool vault is unreadable",
};

export interface LegRow extends LiveLeg {
  symbol: string | null;
  listingMultiplierValue: number;
}
export interface MarketLegsView {
  market: MarketAccount;
  legs: LegRow[];
  shareDecimals: number;
  roles: { marketAdmin: string; guardian: string };
}

/** Listed issuer legs with live issuer state, read directly from chain via the SDK. */
export async function readMarketLegs(
  client: SolanaClient,
  marketId: string,
  nowMs = Date.now(),
): Promise<MarketLegsView> {
  await client.assertNetwork();
  const [market, config] = await Promise.all([
    client.market(key(marketId)),
    client.configAccount(),
  ]);
  const infos = await accountsInfo(client, legAccounts(market, client.config, client.program));
  const live = legStates(
    market,
    infos,
    client.config,
    client.program,
    BigInt(Math.floor(nowMs / 1000)),
  );
  const legs: LegRow[] = [];
  for (let c = 1; c <= market.bases; c++) {
    const leg = live[c]!;
    legs.push({
      ...leg,
      symbol: mintMetadata(infos[c - 1] ?? null)?.symbol || null,
      listingMultiplierValue: multiplierValue(leg.listingMultiplier),
    });
  }
  return {
    market,
    legs,
    shareDecimals: market.terms.share_decimals,
    roles: {
      marketAdmin: config.roles.market_admin.toBase58(),
      guardian: config.roles.guardian.toBase58(),
    },
  };
}

/** Who may change a leg: the guardian may only delist; the market admin may delist or relist. */
export function setBaseAllowed(
  actor: string | null,
  roles: MarketLegsView["roles"],
  active: boolean,
): boolean {
  if (!actor) return false;
  if (actor === roles.marketAdmin) return true;
  return actor === roles.guardian && !active;
}

export function setBaseStep(
  deployment: Parameters<typeof setBaseTransaction>[0],
  actor: string,
  view: MarketLegsView,
  marketId: string,
  collateral: number,
  active: boolean,
): SetupStep[] {
  const leg = view.legs.find((item) => item.collateral === collateral);
  if (!leg) throw new Error("Unknown issuer leg");
  if (leg.active === active)
    throw new Error(`Leg ${collateral} is already ${active ? "listed" : "delisted"}`);
  if (!setBaseAllowed(actor, view.roles, active))
    throw new Error(
      active
        ? "Only the market admin can relist an issuer leg."
        : "Only the guardian or market admin can delist an issuer leg.",
    );
  const transaction = setBaseTransaction(deployment, actor, marketId, collateral, active);
  return toSteps([transaction], transaction.to, {});
}

/** Whitelist one more issuer token (market admin, scheduled/open markets before cutoff, up to
 * three legs). Reads the market fresh; if this token was listed but its claim mints are still
 * missing (an interrupted sequence), returns only the remaining claim steps. */
export async function addIssuerSteps(
  client: SolanaClient,
  marketId: string,
  admin: string,
  mint: string,
  nowMs = Date.now(),
): Promise<{ steps: SetupStep[]; symbol: string | null }> {
  const address = key(mint).toBase58();
  const [market, config] = await Promise.all([
    client.market(key(marketId)),
    client.configAccount(),
  ]);
  if (admin !== config.roles.market_admin.toBase58())
    throw new Error("Only the market admin can list an issuer token.");
  if (market.mints[underlyingAsset(0)]!.toBase58() === address)
    throw new Error("The quote token cannot be a base leg.");
  for (let c = 1; c <= market.bases; c++)
    if (market.mints[underlyingAsset(c)]!.toBase58() === address) {
      const pending = await initializeMarketVaults(client, marketId, admin, []);
      if (!pending.length) throw new Error("Token is already listed on this market.");
      return { steps: toSteps(pending, client.program.toBase58()), symbol: null };
    }
  if (market.bases >= MAX_BASES)
    throw new Error(`Markets list at most ${MAX_BASES} issuer tokens.`);
  if (market.state !== 1 && market.state !== 2)
    throw new Error("Issuer tokens can be added only while the market is scheduled or open.");
  if (BigInt(market.terms.trading_cutoff.toString()) <= BigInt(Math.floor(nowMs / 1000)))
    throw new Error("Trading cutoff has passed; no new issuer tokens can be listed.");
  const check = (await checkIssuerMints(client, [address], nowMs))[address]!;
  if (!check.ok) throw new Error(`${address}: ${check.error}`);
  const problems = issuerLegProblems(check.mint, market.terms.share_decimals);
  if (problems.length) throw new Error(problems[0]);
  const names = { [address]: check.mint.symbol ?? address };
  const transactions = await addBaseTransaction(client, marketId, admin, address);
  return {
    steps: toSteps(transactions, client.program.toBase58(), names),
    symbol: check.mint.symbol,
  };
}

/** Claim mints still missing for already-listed collaterals (anyone may pay). */
export async function pendingClaimSteps(client: SolanaClient, marketId: string, payer: string) {
  return toSteps(
    await initializeMarketVaults(client, marketId, payer, []),
    client.program.toBase58(),
  );
}
