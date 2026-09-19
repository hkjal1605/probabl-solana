import { createHash } from "node:crypto";
import type { SolanaDatabase } from "@conditional-stocks/db/solana";
import {
  activeDelegation,
  address,
  big,
  DELEGATE_TRADE,
  delegationAddress,
  envelope,
  key,
  type OrderWire,
  orderId,
  parseOrder,
  type SolanaClient,
} from "@conditional-stocks/solana-client";
import type { Snapshot } from "@conditional-stocks/solana-indexer/projection";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

const MAX_STALE_REPLANS = 4;
const INDEX_CATCHUP_TIMEOUT_MS = 10_000;

type SimulationFailure = { retryable: boolean; message: string; code: string };

export function delegatedSimulationFailure(logs: string[] | null | undefined): SimulationFailure {
  const code = logs
    ?.map((line) => /Error Code: ([A-Za-z][A-Za-z0-9_]*)/.exec(line)?.[1])
    .find((value): value is string => Boolean(value));
  switch (code) {
    case "StalePlan":
      return {
        retryable: true,
        code,
        message: "The order book changed while placing the order.",
      };
    case "InsufficientFunds":
      return {
        retryable: false,
        code,
        message: "Your available vault balance is insufficient for this order.",
      };
    case "InvalidDelegation":
    case "DelegationInactive":
    case "DelegateBudget":
      return {
        retryable: false,
        code,
        message: "Trading permission is inactive or its allowance is insufficient.",
      };
    case "FeeCap":
      return {
        retryable: false,
        code,
        message: "The current trading fee exceeds your approved fee limit.",
      };
    case "InvalidOrder":
      return {
        retryable: false,
        code,
        message: "This order is no longer open for execution.",
      };
    default:
      return {
        retryable: false,
        code: code ?? "UnknownSimulationFailure",
        message: "The order could not execute against the current on-chain state.",
      };
  }
}

async function waitForIndexedSlot(
  snapshot: () => Promise<Snapshot>,
  minimumSlot: number,
): Promise<Snapshot> {
  const deadline = Date.now() + INDEX_CATCHUP_TIMEOUT_MS;
  let delay = 100;
  while (Date.now() < deadline) {
    const current = await snapshot();
    if (current.slot >= minimumSlot) return current;
    await Bun.sleep(delay);
    delay = Math.min(delay * 2, 800);
  }
  throw new Error("The order book is updating. Please retry in a moment.");
}

/** A dedicated fee-paying trading key. Never use an admin, deployment or custody key. */
export function tradingSigner(secret: string | undefined, expected: string | undefined) {
  if (!secret) return null;
  try {
    const parsed: unknown = secret.trim().startsWith("[")
      ? JSON.parse(secret)
      : [...bs58.decode(secret.trim())];
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 64 ||
      parsed.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
    )
      throw new Error();
    const signer = Keypair.fromSecretKey(Uint8Array.from(parsed));
    if (expected && signer.publicKey.toBase58() !== address(expected)) throw new Error();
    return signer;
  } catch {
    throw new Error(
      "TRADING_DELEGATE_PRIVATE_KEY must be a 64-byte keypair matching TRADING_DELEGATE_ADDRESS (value withheld)",
    );
  }
}

export function tradingPermission(
  s: Snapshot,
  client: SolanaClient,
  signer: Keypair | null,
  owner: string,
) {
  const delegate = signer?.publicKey.toBase58() ?? null;
  const trader = s.traders.get(owner);
  const grant = delegate
    ? s.delegations?.get(
        String(delegationAddress(client.config, key(owner), key(delegate), client.program)),
      )
    : undefined;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const active = Boolean(
    grant &&
      trader &&
      grant.market.equals(PublicKey.default) &&
      !grant.revoked &&
      big(grant.epoch) === big(trader.delegation_epoch) &&
      big(grant.expires_at) > now &&
      (grant.permissions & DELEGATE_TRADE) !== 0 &&
      big(grant.remaining_quote) > 0n,
  );
  return {
    available: Boolean(signer),
    delegate,
    owner,
    active,
    slot: String(s.slot),
    quoteMint: String(s.config.quote_mint),
    quoteDecimals:
      [...s.pools.values()].find((p) => p.mint.equals(s.config.quote_mint))?.decimals ?? null,
    grant: grant
      ? {
          market: String(grant.market),
          expiresAt: String(grant.expires_at),
          maxOrderQuote: String(grant.max_order_quote),
          remainingQuote: String(grant.remaining_quote),
          maxFeeBps: grant.max_fee_bps,
          permissions: grant.permissions,
          revoked: grant.revoked,
        }
      : null,
  };
}

/** The DB owns the submission journal. Repeated HTTP requests resend the same
 * signed bytes; an ambiguous RPC result never creates another transaction. */
export async function submitDelegatedOrder(input: {
  client: SolanaClient;
  db: SolanaDatabase;
  domain: string;
  signer: Keypair;
  owner: string;
  order: OrderWire;
  snapshot: () => Promise<Snapshot>;
  prepare: (
    order: OrderWire,
    snapshot?: Snapshot,
  ) => Promise<{ plan: import("@conditional-stocks/solana-client").AtomicPlan }>;
}) {
  const { client, db, domain, signer, owner } = input;
  const order = parseOrder(input.order);
  if (
    order.maker !== owner ||
    order.recipient !== owner ||
    order.delegate !== String(signer.publicKey)
  )
    throw new Error(
      "Delegated order owner, recipient or signer differs from the authenticated wallet",
    );
  const orderHash = orderId(order, client.program);
  const orderTermsHash = createHash("sha256").update(JSON.stringify(order)).digest("hex");
  return db.locked(`delegated:${domain}:${owner}`, async (queries) => {
    let submission = await queries.delegatedSubmission(domain, orderHash);
    if (!submission) {
      let snapshot = await input.snapshot();
      let built: Awaited<ReturnType<SolanaClient["prepareTransaction"]>> | undefined;
      for (let attempt = 0; attempt <= MAX_STALE_REPLANS; attempt++) {
        const market = snapshot.markets.get(order.marketId);
        if (!market) throw new Error("Unknown indexed market");
        const grant = snapshot.delegations?.get(
          String(delegationAddress(client.config, key(owner), signer.publicKey, client.program)),
        );
        const trader = snapshot.traders.get(owner);
        if (
          !grant ||
          !trader ||
          !activeDelegation(
            grant,
            big(trader.delegation_epoch),
            key(order.marketId),
            BigInt(Math.floor(Date.now() / 1000)),
          )
        )
          throw new Error("Trading permission is inactive");
        const { plan } = await input.prepare(order, snapshot);
        const marketKey = key(order.marketId);
        // Account creation is a live execution concern. An indexed absence may be
        // stale immediately after the owner's first order in this market.
        const wallet = await client.wallet(marketKey, key(owner));
        const instructions = [
          ...(!wallet ? [client.initializeWallet(marketKey, key(owner), signer.publicKey)] : []),
          client.placement(order, plan, market),
        ];
        built = await client.prepareTransaction(
          signer.publicKey,
          envelope(instructions, client.program),
        );
        built.transaction.sign([signer]);
        const simulation = await client.connection.simulateTransaction(built.transaction, {
          sigVerify: true,
          commitment: "confirmed",
        });
        if (!simulation.value.err) break;
        const failure = delegatedSimulationFailure(simulation.value.logs);
        if (!failure.retryable) throw new Error(failure.message);
        if (attempt === MAX_STALE_REPLANS)
          throw new Error("The order book kept changing. Please review the latest quote.");
        snapshot = await waitForIndexedSlot(input.snapshot, simulation.context.slot);
        built = undefined;
      }
      if (!built) throw new Error("Unable to build a current delegated order");
      const signed = built.transaction.serialize();
      const signedSignature = built.transaction.signatures[0];
      if (!signedSignature)
        throw new Error("Delegated transaction is missing the trading signature");
      if ((await queries.delegatedSubmissionCount(domain, owner)) >= 500)
        throw new Error("Daily delegated order limit reached");
      submission = await queries.recordDelegatedSubmission(
        domain,
        orderHash,
        orderTermsHash,
        owner,
        String(signer.publicKey),
        bs58.encode(signedSignature),
        signed,
        built.lastValidBlockHeight,
      );
    }
    if (
      !submission ||
      submission.owner !== owner ||
      submission.delegate !== String(signer.publicKey) ||
      submission.order_terms_hash !== orderTermsHash
    )
      throw new Error("Delegated submission identity mismatch");
    const status = (
      await client.connection.getSignatureStatuses([submission.signature], {
        searchTransactionHistory: true,
      })
    ).value[0];
    if (status?.err) throw new Error("Delegated transaction failed on chain");
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized")
      return { signature: submission.signature, orderHash };
    if (
      (await client.connection.getBlockHeight("confirmed")) >
      Number(submission.last_valid_block_height)
    )
      throw new Error("Delegated transaction expired; review a new order");
    const signed = VersionedTransaction.deserialize(submission.signed_transaction);
    const sent = await client.connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      maxRetries: 2,
    });
    if (sent !== submission.signature)
      throw new Error("RPC returned a different delegated signature");
    const confirmed = await client.connection.confirmTransaction(
      {
        signature: submission.signature,
        blockhash: signed.message.recentBlockhash,
        lastValidBlockHeight: Number(submission.last_valid_block_height),
      },
      "confirmed",
    );
    if (confirmed.value.err) throw new Error("Delegated transaction failed on chain");
    return { signature: submission.signature, orderHash };
  });
}
