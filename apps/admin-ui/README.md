# Admin UI: one condition, multiple markets

The Create market page accepts one **individual Polymarket market slug** and up to 20 unique
Solana base mint addresses. Each base gets a separate local market linked to the same source
condition. This workflow uses the existing single-market API and contract instructions; no
backend, indexer or program upgrade is required.

The quote mint is read from the deployed protocol config and is read-only. The current devnet
deployment uses test USDC. Arbitrary quote mints or a cross-product of base and quote tokens
cannot be enabled solely through this UI.

1. Connect and authenticate the market-admin wallet. Fetch and normalize the slug once.
2. Paste base mint addresses, one per line (commas also work), then load and verify them.
   SPL Token and Token-2022 mints must pass the existing SDK/program extension policy.
   This does not add support for issuer extensions the deployed program rejects. Use wrapped
   SOL's mint for native SOL markets.
3. Review each pair's raw-unit step, tick and caps, plus the shared trading times and sources.
   Defaults account for each mint's actual decimals; displayed whole-token amounts help verify
   the raw inputs. Unusual precision can require adjusting the defaults. Limits remain per
   local market, not pooled across the Polymarket condition.
   Trading open and cutoff use human-readable date/time editors explicitly labelled UTC.
   Seconds are preserved; the API evidence and on-chain instructions still use Unix seconds.
   Opening defaults to the time of metadata fetch, and cutoff to the source's end timestamp.
4. Confirm the immutable fields and prepare all packets. The UI checks live roles, mint
   precision, the quote mint, integer bounds and existing market addresses before preparing.
5. Review and approve each packet, run its transaction preflight, then sign its creation.
   Approval and signing are never automatic. Use the existing reconciliation control after
   the indexer observes each transaction.
6. In Market controls, initialize vaults and open each created market. Settlement is also
   performed separately for each local market using the shared Polymarket outcome.

## Interrupted batches

Preparation is sequential and **not atomic**. The UI retains successful rows and stops at an
ambiguous request result. Use **Recover saved packets** to find the exact packet if the API
saved it before the response was lost; use **Prepare remaining unattempted pairs** for rows
that were never sent. Neither action resends ambiguous or successful requests automatically.

Recovery matches all immutable evidence, including the metadata snapshot, source hash,
deployment, preparer and caps. Multiple matches require manual reconciliation in the review
queue. The existing API returns at most 1,000 packets; the UI stops automatic batch recovery
when that limit is reached rather than treating an incomplete list as proof of absence.

Prepared packets persist in the API and remain in the Review queue after navigation/reload.
The unsent form and in-page batch progress are not persisted. Inspect the review queue before
starting another batch: UI-only coordination cannot guarantee exactly-once requests across
multiple tabs/operators or reloads; strict cross-client idempotency needs backend support.

## Wallet and sign-in persistence

The admin UI remembers the selected wallet and address on this browser/origin without an expiry.
On reload it reconnects silently to trusted injected wallets and rechecks the Solana network
and live operator roles. A locked wallet, revoked site permission, missing extension or cleared
browser storage can still require a manual connection. Disconnect removes the saved wallet
and sign-in; wallet account changes invalidate the previous sign-in as well.

After a successful message signature, the issued API session token is retained for **four hours**
from verification, or less if the API reports an earlier expiry. Refreshing or using the UI does
not extend that deadline. At expiry the wallet stays connected, but signing in again is required.
The session is scoped to the wallet, page origin, Solana genesis hash, program and config.
Request-time checks cover throttled background timers; API 401 responses also clear sign-in.
Other open tabs notice logout, account changes and session replacement through storage events.

This uses `localStorage`: the API bearer token is JavaScript-accessible, not an HttpOnly cookie.
Use a trusted browser and admin origin; compromised same-origin scripts could steal the bearer.
Private keys and the original signed message/signature are never stored or replayed by this UI.
If browser storage is blocked, sign-in still works in memory and a persistence warning is shown.

The four-hour limit is an **admin UI reuse limit**, not a change to server token validity. The
current Solana API issues eight-hour tokens and has no logout/revocation endpoint; clearing the
browser session cannot revoke a copied bearer before its server expiry. This UI change needs
no API or program deployment. Contract actions still require individual wallet signatures.

## Reviewed transaction signing

Admin preflight adds a local compute-unit limit and an explicit zero compute-unit price before
simulation and signing. This preserves the current no-priority-fee policy (base fees and account
rent still apply) and prevents wallets such as Phantom from automatically adding fee instructions
after review. The API cannot supply these compute-budget instructions. Do not override the
app-provided network fee in the wallet: the full signed message must still match the preflighted
message byte for byte, including payer, blockhash, accounts and instruction data. A mismatch
aborts before broadcast; only signatures may change.

## Verification

Run from `apps/admin-ui`:

```sh
bun test test
bun run typecheck --incremental false
```

Batch tests cover shared-source/distinct market addresses, mixed decimals and token programs,
raw-integer boundaries and cap constraints, source/packet tampering, authority/network checks,
sequential preparation, interrupted requests, recovery and session changes. Browser checks
must use isolated API/wallet simulations unless real devnet writes are explicitly intended.
