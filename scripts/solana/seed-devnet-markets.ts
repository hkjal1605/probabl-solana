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
import { assertSignInChallenge, key, SolanaClient } from "@conditional-stocks/solana-client";
import {
  type AdminPreview,
  type AdminTransaction,
  evidenceTransaction,
  initializeMarketVaults,
  lifecycleTransaction,
} from "@conditional-stocks/solana-client/admin";
import bs58 from "bs58";
import type { EvidenceView } from "../../apps/admin-ui/src/lib/admin-api.ts";
import {
  assertBatchPacket,
  buildBatchPlans,
  defaultMarketCaps,
  loadBatchMints,
  type MarketSource,
} from "../../apps/admin-ui/src/lib/market-batch.ts";
import { parseDeployer } from "./devnet-policy.ts";
import { DEVNET_MARKET_SEED, validateMarketSeed } from "./seed-markets-policy.ts";

const PROGRAM = "8S7LwM6yRszZaAoEQqgE1AYcZJLpyVVC5MRr7vqCxLtg";
const CONFIG = "6buYkVtSJjaoozCDsPFYrPhp5g1q1oLg2eLp7FpsZ1tF";
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
interface SeedState {
  apiOrigin: string;
  config: string;
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
const baseMints = [asset("TSLA"), asset("NVDA"), asset("SPY")];
if (config.quote_mint.toBase58() !== asset("USDC")) throw new Error("Unexpected quote mint");

mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
chmodSync(dirname(statePath), 0o700);
const blank = (): SeedState => ({
  version: 1,
  program: PROGRAM,
  config: CONFIG,
  wallet: wallet.publicKey.toBase58(),
  apiOrigin,
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
    !state.records ||
    typeof state.records !== "object"
  )
    throw new Error("Market seed state belongs to another deployment");
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
    const returned = await client.connection.sendRawTransaction(
      Buffer.from(pending.raw, "base64"),
      {
        maxRetries: 5,
        skipPreflight: false,
      },
    );
    if (returned !== pending.signature) throw new Error("RPC returned a different signature");
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
  return (await settlePending(label)) ?? signature;
}

const verified = await loadBatchMints(client, baseMints);
if (verified.deployment.marketAdmin !== wallet.publicKey.toBase58())
  throw new Error("Verified market administrator changed");
const reviewChecklist = {
  "stock-and-quote": true,
  "condition-id": true,
  "yes-no-orientation": true,
  "rules-and-dates": true,
  "source-and-raw-hash": true,
};

for (const [eventIndex, seed] of DEVNET_MARKET_SEED.entries()) {
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
  const plans = buildBatchPlans({
    rows: verified.bases.map((mint) => ({
      mint,
      caps: defaultMarketCaps(mint.decimals, verified.quote.decimals),
    })),
    quote: verified.quote,
    source,
    shared: {
      tradingOpen: String(now - 5),
      tradingCutoff: String(Math.floor(Date.parse(source.normalized.endTime) / 1000)),
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
      assertBatchPacket(plan, packet);
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
    while (true) {
      const market = await client.market(key(id));
      const missing = Array.from({ length: 6 }, (_, index) => index).find(
        (index) => !(market.vaults_initialized & (1 << index)),
      );
      if (missing === undefined) break;
      const transactions = await initializeMarketVaults(client, id, wallet.publicKey.toBase58());
      if (!transactions[0]) throw new Error(`Missing vault transaction ${id}:${missing}`);
      await sendReviewed(transactions[0], `${id}:vault:${missing}`);
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
    markets: DEVNET_MARKET_SEED.length * baseMints.length,
    assets: ["TSLA", "NVDA", "SPY"],
  }),
);
