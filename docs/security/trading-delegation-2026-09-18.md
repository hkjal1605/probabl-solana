# Trading-only delegated keys

## Status

Implemented in the fresh-deployment Rust program, generated IDL and TypeScript SDK, with indexed delegation filtering and API signer selection. No live deployment, real key generation, credential storage, or production trading took place. This builds on the protocol-wide vault changes; their remaining application balance/indexer cutover tasks still apply.

These are delegated **signing keys**, not separate balance subaccounts. The owner retains the assets, positions, claims and order identities. Giving two bots different keys does not isolate their P&L or deposit balances.

## Research and decisions

Reviewed the relevant authorization paths in these primary sources on 2026-09-18:

| Reference | Relevant pattern | Application here |
| --- | --- | --- |
| [Drift signer constraints](https://github.com/drift-labs/protocol-v2/blob/master/programs/drift/src/instructions/constraints.rs) and [user instruction accounts](https://github.com/drift-labs/protocol-v2/blob/master/programs/drift/src/instructions/user.rs) | Trading accepts an authority or delegate; withdrawals require the authority. | Separate transaction signer from beneficial owner, with no delegated withdrawal path. |
| [GMX SubaccountUtils](https://github.com/gmx-io/gmx-synthetics/blob/main/contracts/subaccount/SubaccountUtils.sol) and [SubaccountRouter](https://github.com/gmx-io/gmx-synthetics/blob/main/contracts/router/SubaccountRouter.sol) | Scoped actions, expiry/counters and recipient restrictions. | Mandatory expiry and order/budget limits; proceeds cannot be redirected away from the owner. GMX's [current integration guide](https://docs.gmx.io/docs/api/contracts/delegated-trading/) recommends relay routers for new GMX integrations; the older router was examined as a reference, not copied as a current integration target. |
| [Hyperliquid API-wallet documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets) and [official Python SDK](https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/master/hyperliquid/exchange.py) | Agent signer differs from the account owning funds; reuse of pruned agent keys can cause replay issues. | Permanent, non-reusable grant addresses; owner nonce and delegation-epoch state never reset. These references describe its API/SDK, not a reviewed copy of Hyperliquid's execution engine. |
| [Polymarket exchange signature validation](https://github.com/Polymarket/ctf-exchange/blob/main/src/exchange/mixins/Signatures.sol) and [official authentication reference](https://github.com/Polymarket/agent-skills/blob/main/authentication.md) | Maker/funder and signer have explicit verified relationships; HTTP API authentication is separate from order-signing authority. | HTTP sessions cannot create on-chain authority. The delegate must sign the actual Solana transaction and hold a valid on-chain owner-approved grant. |

This is an original implementation of established permission-separation patterns, **not an assertion that this new code is itself battle-tested or audited by those protocols**. No SPL `Approve` allowance, EVM wallet proxy, custom signature recovery, ed25519-message parser or arbitrary execution module was added. Solana's native transaction signatures authenticate the delegated signer.

## Owner-approved capability

`TradingDelegate` is a 173-byte account, including discriminator, derived from:

```text
delegate / config / owner / delegate_public_key
```

The owner signs `approve_delegate` and chooses:

- One market, or explicitly all markets under the config.
- A required expiry no more than 90 days ahead. There is no perpetual-grant sentinel.
- Maximum submitted notional per order, and a total lifetime notional allowance.
- A maximum permitted order fee cap.
- `TRADE` or `TRADE | CANCEL`. Unknown permission bits are rejected.

Amounts are **raw units of the config's quote mint**, not dollars or floating-point numbers. The full order notional, rounded up at its submitted limit, consumes the allowance for BUY and SELL orders. IOC unfilled quantities, price improvements, cancellations and earned proceeds do not replenish it. An unsuccessful transaction consumes nothing. This deliberately conservative turnover cap prevents cancel/requote loops from recycling authorization; market makers must choose an adequate allowance and rotate keys when it is exhausted. Exhaustion does not invalidate already-reserved orders.

Grant scope/limits/expiry cannot be widened by the delegate or updated in place. A new authorization uses a **new public key**. Grant accounts are never closed, reused or un-revoked. No owner-signed update path silently resets a spent allowance.

## Enforced permissions

| Action | Owner | Delegated key |
| --- | --- | --- |
| Place/match an order | Yes | Within active grant and existing market limits |
| Receive trade proceeds | Chosen recipient for direct owner orders | Owner only, for both active and inactive claims |
| Cancel an order | Any own order | Only orders created by that exact key, within scope, with `CANCEL` permission |
| Batch cancel | Any own orders | Same restriction on every entry; one foreign entry rolls back the batch |
| Withdraw underlying/claims or transfer credits | Yes | No |
| Explicit split, merge or redeem | Yes | No; these were not implicitly bundled into trading permission |
| Approve/revoke keys, revoke all, invalidate owner order nonce | Yes | No |
| Retire orders / collect returned order-account rent | Yes | No |

Owner-independent account initialization can still be paid for by another signer; it grants no authority and cannot reset the owner's nonce or revocation epoch. Deposits remain owner-authorized. Delegated trading consumes predeposited balances; the SDK does not silently construct an owner-funded deposit transaction for a delegate.

The delegate is the instruction's order-rent payer. The transaction fee payer can be supplied by a client/relayer that signs appropriately; automatic sponsorship is not implemented. Order rent remains recoverable only by the beneficial owner under the existing retirement rules. Delegation does not make network fees or rent disappear.

## Revocation, resting orders and replay

`revoke_delegate` is irreversible and idempotent. `revoke_all_delegates` increments a checked owner-wide epoch in the existing Trader account. Every grant records its creation epoch; grants from older epochs immediately stop authorizing operations. Creating another market wallet or approving another key never resets either `minimum_nonce` or `delegation_epoch`.

Every delegated Order stores its originating delegate public key (32 additional bytes). When matching an existing maker, settlement requires its canonical, current grant and the already-required owner Trader account. It checks revocation, epoch, expiry, market scope and trading permission again. Therefore a resting order does not remain executable after revocation, even if a counterparty prepared a transaction earlier. The maker grant is readonly; remaining allowance is charged only when a new order is placed.

Revocation does not automatically scan and cancel every order or release their reservations. Instead, revoked/expired/epoch-invalidated orders stop filling and become permissionlessly cancellable, with refunds forced back to the original owner. Owners can always cancel their own orders, including in batches. The indexer filters inactive delegated liquidity out of the live book; confirmation/indexing delay can affect display, but not the on-chain check.

All delegated orders require nonce-bound salts. Existing owner-wide order nonce checks still apply to both takers and makers. Retirement remains governed by permanent owner nonce invalidation or permanent market closure, not just key revocation. That prevents recreating a retired order address under a different authorization. An old grant cannot become valid again when an old key is reused because its PDA is never deleted and cannot be reapproved.

Solana account locks serialize grant revocation against matching and global epoch invalidation against Trader reads. Revocation cannot undo a transaction ordered/executed before it. Treat revocation as effective after the required confirmation, not merely after pressing a UI button.

## SDK / future API accounts

```ts
// Generate and secure the key outside the SDK. Do not send private keys to the API.
const approval = client.approveDelegate(owner, botPublicKey, {
  market: null,                 // Explicit all-market grant; use a market key to restrict.
  expiresAt,                   // Unix seconds, bigint, within 90 days.
  maxOrderQuote, totalQuote,    // Raw quote units, bigint; choose deliberately.
  maxFeeBps: 50,
  permissions: DELEGATE_TRADE | DELEGATE_CANCEL,
}); // OWNER signs.

const order = {
  ...reviewedOrder,
  maker: owner.toBase58(),
  recipient: owner.toBase58(),
  delegate: botPublicKey.toBase58(),
};
const ix = client.placement(order, plan, indexedMarket); // BOT signs; owner need not sign.
const cancel = await client.cancel(orderAddress, botPublicKey);
const revoke = client.revokeDelegate(owner, botPublicKey); // OWNER signs.
const emergency = client.revokeAllDelegates(owner);        // OWNER signs.
```

`orderWire` preserves delegate provenance. Placement builders add deduplicated maker grants and the taker's writable grant without extra per-order RPC. The indexer decodes grants from its existing account snapshot and filters revoked orders; review checks scope, epoch and allowance against that snapshot. `/v1/orders/transaction` requires the authenticated session to match the signing key (`delegate` when present, otherwise `maker`), while settlement independently enforces the owner/grant relationship. Withdraw endpoints still operate only on the authenticated wallet's own credit.

Existing wallet-signature login can authenticate a bot key; a new API-key issuance/secret-storage service and browser-session-key UI are **not** included here. Neither HTTP credentials nor a database permission row can replace the on-chain grant. Future signing-key custody, credential rotation, revocation UX, sponsorship and deployment cutover require their own implementation/review.

## Safety boundaries

A trading key can lose funds through adverse trades, collusion with counterparties, fee expenditure or poor execution. Owner-only recipients prevent direct redirection of proceeds, **not indirect extraction through bad prices**. The notional allowance is not a USD loss cap: a cheap SELL can transfer valuable base assets for little quote. There is no newly introduced trusted oracle enforcing fair execution, and no claim that delegation isolates a portion of the owner's global portfolio. For stronger capital isolation, use a separately funded owner account; a true isolated subaccount/risk-budget design would be additional work.

Use minimal market scope, short expiry, conservative caps, and separate keys per process. Do not label a delegated key “read-only” or harmless because it cannot withdraw. Token issuer risks and supported-extension restrictions are unchanged. Independent security review remains required before meaningful funds; passing tests does not prove an absence of exploitable bugs.

## Verification

New host tests cover identity/PDA/program ownership, all 256 permission masks, expiry boundaries, checked allowance arithmetic, receiver/fee/nonce restrictions and irrevocable epoch semantics. Local-validator tests submit real transactions with generated wallets and check owner/delegate separation, matching, global pool balances, scoped permissions, individual/global revocation, pre-signed transaction rejection, budget rollback/exhaustion, cancellation atomicity, withdrawal/management attacks, expired grants, self-matching alias safety, malformed approvals and replay after retirement. The shared-vault SPL/Token-2022/wrapped-SOL suite is rerun against the same program.

Compiled-SBF stress tests include eight distinct maker grants with whole-funded and claim-funded orders, and eight global rounding refunds. They use the default heap and retain checked accounting/supply invariants. Sample measurements: eight whole-funded delegated makers 230,972 CU, eight claim-funded delegated makers 199,764 CU, and eight delegated makers with global refunds 259,077 CU. These are fixture measurements, not guaranteed transaction fees. Account/packet limits still apply; address lookup tables do not bypass account locks or account-count limits.

```sh
cargo test --workspace --offline
bun run test:costs
bun run test:ts
bun run typecheck
cargo clippy --workspace --all-targets --offline -- -D warnings
# Fresh compiled program on a disposable localhost validator:
SOLANA_DELEGATION_TEST_RPC=http://127.0.0.1:8911 bun run test:delegation
SOLANA_POOL_TEST_RPC=http://127.0.0.1:8911 bun run test:pools
```

The CI validator job includes both suites; remote CI has not been executed here. The subsequent [services cutover](protocol-wide-services-2026-09-18.md) ports and executes the real API/indexer application harness for both SPL and fee-bearing Token-2022. Older standalone gated fixtures are not claimed as passing coverage. No backwards-compatibility or migration claim is made.

Final local verification of the rebuilt delegation program:

- 35 Rust workspace tests passed; six opt-in compiled-SBF tests passed separately.
- 417 fast TypeScript tests passed, with 75 environment-gated tests skipped in that command. Skips are not counted as passing coverage.
- All 16 new delegation integration tests passed on the disposable localhost validator using the SDK's actual compute budgets, including the trade-only key's permissionless release of a nonce-invalidated order.
- All 13 shared-vault integration regressions also passed against that same binary: 29 validator tests, 366 assertions, zero failures in the combined run.
- Workspace typechecks, Clippy with warnings denied, Rust formatting, generated/SDK IDL equality and diff whitespace checks passed.
- Tested SBF SHA-256: `0ca117b47e7ee52068835eaa7d7d36c61aacd4932837216eacf91774ecc9ba47`.
