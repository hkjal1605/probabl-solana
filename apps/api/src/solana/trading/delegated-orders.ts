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
  walletAddress,
} from "@conditional-stocks/solana-client";
import type { Snapshot } from "@conditional-stocks/solana-indexer/projection";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

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
  let submission = await db.delegatedSubmission(domain, orderHash);
  if (!submission) {
    const s = await input.snapshot(),
      m = s.markets.get(order.marketId);
    if (!m) throw new Error("Unknown indexed market");
    const grant = s.delegations?.get(
      String(delegationAddress(client.config, key(owner), signer.publicKey, client.program)),
    );
    const trader = s.traders.get(owner);
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
    const { plan } = await input.prepare(order);
    const marketKey = key(order.marketId);
    const instructions = [
      ...(!s.wallets.has(String(walletAddress(marketKey, key(owner), client.program)))
        ? [client.initializeWallet(marketKey, key(owner), signer.publicKey)]
        : []),
      client.placement(order, plan, m),
    ];
    const tx = envelope(instructions, client.program);
    const built = await client.prepareTransaction(signer.publicKey, tx);
    built.transaction.sign([signer]);
    const simulation = await client.connection.simulateTransaction(built.transaction, {
      sigVerify: true,
      commitment: "confirmed",
    });
    if (simulation.value.err) throw new Error("Delegated placement simulation failed");
    const signed = built.transaction.serialize();
    const signedSignature = built.transaction.signatures[0];
    if (!signedSignature) throw new Error("Delegated transaction is missing the trading signature");
    const signature = bs58.encode(signedSignature);
    submission = await db.locked(`delegated:${domain}:${owner}`, async (queries) => {
      const previous = await queries.delegatedSubmission(domain, orderHash);
      if (previous) return previous;
      if ((await queries.delegatedSubmissionCount(domain, owner)) >= 500)
        throw new Error("Daily delegated order limit reached");
      return queries.recordDelegatedSubmission(
        domain,
        orderHash,
        orderTermsHash,
        owner,
        String(signer.publicKey),
        signature,
        signed,
        built.lastValidBlockHeight,
      );
    });
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
}
