import { createPrivateKey, sign } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  assertSignInChallenge,
  envelope,
  key,
  MAX_BASES,
  poolAddress,
  SolanaClient,
} from "@conditional-stocks/solana-client";
import {
  type AdminPreview,
  type AdminTransaction,
  evidenceTransaction,
  initializeMarketVaults,
  lifecycleTransaction,
} from "@conditional-stocks/solana-client/admin";
import { assertEvidenceIntegrity } from "@conditional-stocks/solana-client/evidence";
import bs58 from "bs58";
import type { EvidenceView } from "../../apps/admin-ui/src/lib/admin-api.ts";
import {
  assertBatchPacket,
  buildBatchPlans,
  defaultMarketCaps,
  loadBatchMints,
  type MarketSource,
  resolveRows,
} from "../../apps/admin-ui/src/lib/market-batch.ts";
import { DEFAULT_SHARE_DECIMALS } from "../../apps/admin-ui/src/lib/issuer-mints.ts";
import { canonicalStringify } from "../../packages/market-data/src/index.ts";
import { MARKET_TICKERS, marketLegs, parseDeployer } from "./devnet-policy.ts";
import { DEVNET_MARKET_SEED, validateMarketSeed } from "./seed-markets-policy.ts";

const PROGRAM = "53gtyz9nYzS7vwSbx2v7GeGLrMTas7vCATkjiKvAG1ra";
const CONFIG = "EfXom6mQxuw5gsHG4AujCgo1dQ3qWg5pN85RvY1ysn23";
const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const AUTH_ORIGIN = "http://localhost:3001";
const ROOT = resolve(import.meta.dir, "../..");
const statePath = resolve(ROOT, ".local/devnet/market-seed.json");

interface PendingTransaction {
  blockhash: string;
  label: string;
  lastValidBlockHeight: number;
  raw: string;
  signature: string;
}
interface MarketRecord {
  creationSignature?: string;
  opened?: true;
  packetHash?: string;
  reconciled?: true;
}
interface EventTiming {
  tradingCutoff: string;
  tradingOpen: string;
}
interface SeedState {
  apiOrigin: string;
  config: string;
  events: Record<string, EventTiming>;
  pending?: PendingTransaction;
  program: string;
  records: Record<string, MarketRecord>;
  version: 1;
  wallet: string;
}

const execute = process.argv.includes("--execute");
if (!execute) throw new Error("Market seeding requires an explicit --execute flag");
validateMarketSeed();
const wallet = parseDeployer(process.env.DEVNET_DEPLOYER_PRIVATE_KEY);
if (wallet.publicKey.toBase58() !== "4o2JYy6ktdZEfaUVHGwdCbvMyypZ1NRCDpyS1rfY9q8z")
  throw new Error("Unexpected Devnet market administrator");
const rpcUrl = process.env.DEVNET_BROWSER_RPC_URL ?? process.env.DEVNET_RPC_URL;
if (!rpcUrl) throw new Error("DEVNET_BROWSER_RPC_URL or DEVNET_RPC_URL is required");
const rpc = new URL(rpcUrl);
if (rpc.protocol !== "https:" || rpc.username || rpc.password || rpc.hash)
  throw new Error("Devnet RPC must be credential-free HTTPS URL syntax");
const apiOrigin = new URL(process.env.DEVNET_API_ORIGIN ?? "https://api-solana.probabl.trade")
  .origin;
if (!apiOrigin.startsWith("https://")) throw new Error("Devnet API must use HTTPS");

const deployment = {
  rpcUrl: rpc.toString(),
  programId: PROGRAM,
  config: CONFIG,
  genesisHash: GENESIS,
};
const client = new SolanaClient(deployment);
await client.assertNetwork();
const config = await client.configAccount();
if (
  !config.roles.market_admin.equals(wallet.publicKey) ||
  !config.roles.resolution_admin.equals(wallet.publicKey)
)
  throw new Error("Deployer is not the live market and resolution administrator");

const deploymentPlan = JSON.parse(
  readFileSync(resolve(ROOT, ".local/devnet/deployment.json"), "utf8"),
) as {
  programId: string;
  config: string;
  deployer: string;
  assets: Array<{ symbol: string; mint: string }>;
};
if (
  deploymentPlan.programId !== PROGRAM ||
  deploymentPlan.config !== CONFIG ||
  deploymentPlan.deployer !== wallet.publicKey.toBase58()
)
  throw new Error("Local deployment record differs from the live seed domain");
const asset = (symbol: string) => {
  const matches = deploymentPlan.assets.filter((entry) => entry.symbol === symbol);
  if (matches.length !== 1) throw new Error(`Missing unique ${symbol} fixture mint`);
  const match = matches[0];
  if (!match) throw new Error(`Missing ${symbol} fixture mint`);
  return match.mint;
};
// Every asset's base legs in policy order: issuer tokens (xStocks / Ondo /
// PreStocks / Tessera replicas) or the crypto mock; each event lists the rows
// of its own three assets.
const assetRows = MARKET_TICKERS.map((ticker) => marketLegs(ticker).map((leg) => asset(leg.symbol)));
if (assetRows.some((row) => row.length < 1 || row.length > MAX_BASES))
  throw new Error("Every seeded asset market lists 1-3 issuer tokens");
if (config.quote_mint.toBase58() !== asset("USDC")) throw new Error("Unexpected quote mint");

mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
chmodSync(dirname(statePath), 0o700);
const blank = (): SeedState => ({
  version: 1,
  program: PROGRAM,
  config: CONFIG,
  wallet: wallet.publicKey.toBase58(),
  apiOrigin,
  events: {},
  records: {},
});
let state = blank();
if (existsSync(statePath)) {
  const info = lstatSync(statePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid market seed state file");
  state = JSON.parse(readFileSync(statePath, "utf8")) as SeedState;
  if (
    state.version !== 1 ||
    state.program !== PROGRAM ||
    state.config !== CONFIG ||
    state.wallet !== wallet.publicKey.toBase58() ||
    state.apiOrigin !== apiOrigin ||
    (state.events !== undefined &&
      (!state.events || typeof state.events !== "object" || Array.isArray(state.events))) ||
    !state.records ||
    typeof state.records !== "object"
  )
    throw new Error("Market seed state belongs to another deployment");
  state.events ??= {};
}
const save = () => {
  const temporary = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, statePath);
  chmodSync(statePath, 0o600);
};
save();

async function api<T>(path: string, body?: unknown, token?: string): Promise<T> {
  const headers = new Headers({ accept: "application/json" });
  if (body !== undefined) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const init: RequestInit = {
    method: body === undefined ? "GET" : "POST",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(new URL(path, apiOrigin), init);
  const value = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  if (!response.ok)
    throw new Error(value?.error?.message ?? `API ${path} returned ${response.status}`);
  return value as T;
}

const challenge = await api<{ challengeId: string; message: string }>("/v1/auth/challenge", {
  address: wallet.publicKey.toBase58(),
  origin: AUTH_ORIGIN,
});
assertSignInChallenge(
  challenge,
  wallet.publicKey.toBase58(),
  { ...deployment, programId: PROGRAM },
  AUTH_ORIGIN,
);
const session = await api<{ token: string }>("/v1/auth/verify", {
  address: wallet.publicKey.toBase58(),
  challengeId: challenge.challengeId,
  signature: bs58.encode(
    sign(
      null,
      Buffer.from(challenge.message),
      createPrivateKey({
        key: Buffer.concat([
          Buffer.from("302e020100300506032b657004220420", "hex"),
          Buffer.from(wallet.secretKey.subarray(0, 32)),
        ]),
        format: "der",
        type: "pkcs8",
      }),
    ),
  ),
});
if (!/^[a-f0-9]{64}$/.test(session.token)) throw new Error("Invalid operator session");

async function settlePending(label: string): Promise<string | null> {
  const pending = state.pending;
  if (!pending) return null;
  if (pending.label !== label)
    throw new Error(`Resolve pending transaction ${pending.label} before ${label}`);
  const status = (
    await client.connection.getSignatureStatuses([pending.signature], {
      searchTransactionHistory: true,
    })
  ).value[0];
  if (status?.err) throw new Error(`${label} failed: ${JSON.stringify(status.err)}`);
  if (status?.confirmationStatus === "finalized") {
    delete state.pending;
    save();
    return pending.signature;
  }
  if (!status) {
    const height = await client.connection.getBlockHeight("confirmed");
    if (height > pending.lastValidBlockHeight) {
      delete state.pending;
      save();
      return null;
    }
    try {
      const returned = await client.connection.sendRawTransaction(
        Buffer.from(pending.raw, "base64"),
        {
          maxRetries: 5,
          skipPreflight: false,
        },
      );
      if (returned !== pending.signature) throw new Error("RPC returned a different signature");
    } catch (error) {
      // A provider can lag getSignatureStatuses yet reject the identical bytes
      // as already landed. Only this exact idempotent response may continue to
      // confirmation; every other submission error remains fatal.
      if (!(error instanceof Error) || !/already been processed/i.test(error.message)) throw error;
    }
  }
  const confirmation = await client.connection.confirmTransaction(
    {
      signature: pending.signature,
      blockhash: pending.blockhash,
      lastValidBlockHeight: pending.lastValidBlockHeight,
    },
    "finalized",
  );
  if (confirmation.value.err)
    throw new Error(`${label} failed: ${JSON.stringify(confirmation.value.err)}`);
  delete state.pending;
  save();
  return pending.signature;
}

async function sendReviewed(transaction: AdminTransaction, label: string) {
  const resumed = await settlePending(label);
  if (resumed) return resumed;
  const built = await client.prepareTransaction(wallet.publicKey, transaction, {
    pinWalletFees: true,
  });
  built.transaction.sign([wallet]);
  const simulation = await client.connection.simulateTransaction(built.transaction, {
    commitment: "confirmed",
    sigVerify: true,
  });
  if (simulation.value.err)
    throw new Error(`${label} simulation failed: ${JSON.stringify(simulation.value.err)}`);
  const raw = built.transaction.serialize();
  const signatureBytes = built.transaction.signatures[0];
  if (signatureBytes?.length !== 64)
    throw new Error("Signed transaction has no canonical signature");
  const signature = bs58.encode(signatureBytes);
  state.pending = {
    label,
    signature,
    raw: Buffer.from(raw).toString("base64"),
    blockhash: built.blockhash,
    lastValidBlockHeight: built.lastValidBlockHeight,
  };
  save();
  const returned = await client.connection.sendRawTransaction(raw, {
    maxRetries: 5,
    skipPreflight: false,
  });
  if (returned !== signature) throw new Error("RPC returned a different signature");
  const confirmation = await client.connection.confirmTransaction(
    {
      signature,
      blockhash: built.blockhash,
      lastValidBlockHeight: built.lastValidBlockHeight,
    },
    "finalized",
  );
  if (confirmation.value.err)
    throw new Error(`${label} failed: ${JSON.stringify(confirmation.value.err)}`);
  delete state.pending;
  save();
  return signature;
}

// A market address commits to its trading window. Recover the timing from any
// already-created market before building plans so an interrupted run cannot
// silently derive a second address from a newer `Date.now()` value.
if (state.pending) {
  const label = state.pending.label;
  const signature = await settlePending(label);
  if (signature && label.endsWith(":create")) {
    const marketId = label.slice(0, -":create".length);
    const record = state.records[marketId];
    if (!record) throw new Error(`Pending creation has no journal record: ${marketId}`);
    record.creationSignature = signature;
    save();
  }
}
for (const [marketId, record] of Object.entries(state.records)) {
  if (!record.packetHash) continue;
  const existing = await client.connection.getAccountInfo(key(marketId), "confirmed");
  if (!existing) continue;
  const evidence = await api<EvidenceView>(
    `/v1/admin/evidence/${record.packetHash}`,
    undefined,
    session.token,
  );
  if (evidence.envelope.packet.kind !== "market-creation")
    throw new Error(`Seed record ${marketId} does not reference creation evidence`);
  const packet = evidence.envelope.packet;
  const recovered = {
    tradingOpen: packet.config.tradingOpen,
    tradingCutoff: packet.config.tradingCutoff,
  };
  const prior = state.events[packet.polymarket.gammaMarketId];
  if (
    prior &&
    (prior.tradingOpen !== recovered.tradingOpen || prior.tradingCutoff !== recovered.tradingCutoff)
  )
    throw new Error(`Conflicting live timing for Polymarket ${packet.polymarket.gammaMarketId}`);
  state.events[packet.polymarket.gammaMarketId] = recovered;
}
save();

const verified = await loadBatchMints(client, assetRows);
if (verified.deployment.marketAdmin !== wallet.publicKey.toBase58())
  throw new Error("Verified market administrator changed");
const resolved = resolveRows(
  verified,
  assetRows.map((mints) => ({
    mints,
    shareDecimals: String(DEFAULT_SHARE_DECIMALS),
    caps: defaultMarketCaps(DEFAULT_SHARE_DECIMALS, verified.quote.decimals),
  })),
);
if (resolved.problems.some((list) => list.length))
  throw new Error(`Issuer legs are not listable: ${JSON.stringify(resolved.problems)}`);

// create_market requires the deployment's quote custody pool (admits no
// issuer controls). Base-leg pools are created by initializeMarketVaults.
const quoteMint = config.quote_mint;
if (!(await client.connection.getAccountInfo(poolAddress(client.config, quoteMint, client.program), "confirmed"))) {
  const quoteProgram = (await client.connection.getAccountInfo(quoteMint, "confirmed"))?.owner;
  if (!quoteProgram) throw new Error("Quote mint is missing");
  await sendReviewed(
    {
      ...envelope([client.initializePool(quoteMint, wallet.publicKey, quoteProgram, 0)], client.program),
      from: wallet.publicKey.toBase58(),
      chainId: 1,
    },
    "quote-pool",
  );
}
const reviewChecklist = {
  "stock-and-quote": true,
  "condition-id": true,
  "yes-no-orientation": true,
  "rules-and-dates": true,
  "source-and-raw-hash": true,
};

function assertResumedPacket(plan: ReturnType<typeof buildBatchPlans>[number], view: EvidenceView) {
  assertEvidenceIntegrity(view.envelope);
  const actual = view.envelope.packet;
  const expected = plan.envelope.packet;
  if (actual.kind !== "market-creation" || expected.kind !== "market-creation")
    throw new Error("Stored seed evidence is not market-creation evidence");
  const {
    metadataRawHash: _actualRawHash,
    metadataSnapshotId: _actualSnapshotId,
    ...actualPolymarket
  } = actual.polymarket;
  const {
    metadataRawHash: _expectedRawHash,
    metadataSnapshotId: _expectedSnapshotId,
    ...expectedPolymarket
  } = expected.polymarket;
  if (
    canonicalStringify(actual.config) !== canonicalStringify(expected.config) ||
    canonicalStringify(actual.deployment) !== canonicalStringify(expected.deployment) ||
    canonicalStringify(actualPolymarket) !== canonicalStringify(expectedPolymarket) ||
    canonicalStringify(actual.sourceUrls) !== canonicalStringify(expected.sourceUrls) ||
    canonicalStringify(actual.attachments) !== canonicalStringify(expected.attachments) ||
    actual.preparer !== expected.preparer ||
    evidenceTransaction(view.envelope, "create-market", verified.deployment).expectedMarketId !==
      plan.expectedMarketId
  )
    throw new Error("Stored seed evidence differs from the pinned market plan");
}

// Optional explicit subset (comma-separated Gamma market ids) of events to seed.
const only = process.env.DEVNET_SEED_EVENTS
  ? new Set(process.env.DEVNET_SEED_EVENTS.split(",").map((id) => id.trim()).filter(Boolean))
  : null;
if (only && [...only].some((id) => !DEVNET_MARKET_SEED.some((seed) => seed.gammaMarketId === id)))
  throw new Error("DEVNET_SEED_EVENTS lists an event outside the reviewed catalogue");
for (const [eventIndex, seed] of DEVNET_MARKET_SEED.entries()) {
  if (only && !only.has(seed.gammaMarketId)) continue;
  const source = await api<MarketSource>(
    "/v1/admin/polymarket/metadata/fetch",
    { gammaMarketId: seed.gammaMarketId },
    session.token,
  );
  if (
    source.normalized.gammaMarketId !== seed.gammaMarketId ||
    source.normalized.slug !== seed.slug ||
    source.normalized.question !== seed.question ||
    Date.parse(source.normalized.endTime) <= Date.now()
  )
    throw new Error(`Polymarket source changed or closed: ${seed.slug}`);
  const now = Math.floor(Date.now() / 1000);
  let timing = state.events[seed.gammaMarketId];
  if (!timing) {
    timing = {
      tradingOpen: String(now - 5),
      tradingCutoff: String(Math.floor(Date.parse(source.normalized.endTime) / 1000)),
    };
    state.events[seed.gammaMarketId] = timing;
  }
  save();
  const plans = buildBatchPlans({
    // The event's own three assets, each with its issuer legs.
    rows: seed.tickers.map((ticker) => resolved.rows[MARKET_TICKERS.indexOf(ticker)]!),
    quote: verified.quote,
    source,
    shared: {
      tradingOpen: timing.tradingOpen,
      tradingCutoff: timing.tradingCutoff,
      metadataUri: source.normalized.canonicalUrl,
      sourceUrls: source.normalized.canonicalUrl,
    },
    deployment: verified.deployment,
    owner: wallet.publicKey.toBase58(),
  });
  for (const [assetIndex, plan] of plans.entries()) {
    const id = plan.expectedMarketId;
    if (!state.records[id]) state.records[id] = {};
    const record = state.records[id];
    if (!record) throw new Error("Failed to initialize seed record");
    let packet: EvidenceView;
    if (!record.packetHash) {
      packet = await api<EvidenceView>(
        "/v1/admin/evidence/creation/prepare",
        plan.body,
        session.token,
      );
      assertBatchPacket(plan, packet);
      record.packetHash = packet.envelope.packetHash;
      save();
    } else {
      packet = await api<EvidenceView>(
        `/v1/admin/evidence/${record.packetHash}`,
        undefined,
        session.token,
      );
      assertResumedPacket(plan, packet);
    }
    if (packet.status === "rejected") throw new Error(`Evidence was rejected for ${id}`);
    if (packet.status === "prepared")
      packet = await api<EvidenceView>(
        `/v1/admin/evidence/${record.packetHash}/review`,
        {
          decision: "approve",
          checklist: reviewChecklist,
          notes: `Reviewed Devnet ${seed.category} seed: ${seed.slug}`,
        },
        session.token,
      );
    if (packet.status !== "approved") throw new Error(`Evidence is not approved for ${id}`);
    const existing = await client.connection.getAccountInfo(key(id), "confirmed");
    if (!existing) {
      const preview = await api<AdminPreview>(
        `/v1/admin/evidence/${record.packetHash}/transaction`,
        {},
        session.token,
      );
      const expected = evidenceTransaction(packet.envelope, "create-market", verified.deployment);
      for (const field of ["from", "to", "data", "value", "chainId", "expectedMarketId"] as const)
        if (preview[field] !== expected[field])
          throw new Error(`API changed reviewed creation field ${field}`);
      record.creationSignature = await sendReviewed(preview, `${id}:create`);
      save();
    }
    if (!record.creationSignature && !record.reconciled)
      throw new Error(`Existing market ${id} has no local creation receipt`);
    if (!record.reconciled) {
      await api(
        `/v1/admin/evidence/${record.packetHash}/reconcile`,
        { action: "create-market", transactionHash: record.creationSignature },
        session.token,
      );
      record.reconciled = true;
      save();
    }
    // List every issuer leg (custody pool with exact admission, add_base), then
    // create every claim mint. Each step is one reviewed, journaled transaction;
    // the remaining steps are recomputed from chain state after each one.
    while (true) {
      const transactions = await initializeMarketVaults(
        client,
        id,
        wallet.publicKey.toBase58(),
        plan.baseTokens,
      );
      const next = transactions[0];
      if (!next) break;
      const market = await client.market(key(id));
      await sendReviewed(next, `${id}:vaults:${market.bases}:${market.vaults_initialized}`);
    }
    const market = await client.market(key(id));
    if (market.state === 1)
      await sendReviewed(
        lifecycleTransaction(verified.deployment, wallet.publicKey.toBase58(), id, 0),
        `${id}:open`,
      );
    else if (market.state !== 2) throw new Error(`Market ${id} is not scheduled or open`);
    record.opened = true;
    save();
    console.log(
      JSON.stringify({
        event: eventIndex + 1,
        asset: assetIndex + 1,
        category: seed.category,
        slug: seed.slug,
        market: id,
        state: "open",
      }),
    );
  }
}

console.log(
  JSON.stringify({
    complete: true,
    events: DEVNET_MARKET_SEED.length,
    markets: DEVNET_MARKET_SEED.reduce((sum, seed) => sum + seed.tickers.length, 0),
    assets: MARKET_TICKERS,
    legs: Object.fromEntries(
      MARKET_TICKERS.map((ticker) => [ticker, marketLegs(ticker).map((leg) => leg.symbol)]),
    ),
  }),
);
