# Atomic execution hardening — work record

Status: implementation and scoped verification complete. See the [fresh security
report](../../audit/2026-09-08/atomic-hardening/REPORT.md) for final source identity,
evidence, incomplete whole-service coverage and remaining release boundaries.

## Agreed requirements

- The API selects best-priced eligible liquidity, FIFO within a price. External
  callers may choose other counterparties without bypassing ownership, signatures,
  limits, fees, collateral conservation or recovery authorization.
- Failed individual payouts become beneficiary-owned withdrawal credits in a new
  immutable vault. Successful payouts reach their intended recipients in the same
  transaction. No administrator withdrawal, conversion, or added fee.
- Receiver code cannot interrupt later fill accounting: materialize all fills
  before attempting recipient callbacks. All attempts are gas-bounded; withdrawals
  can use a beneficiary-chosen destination and sufficient gas.
- Wallet/market open-order caps apply to the final atomic resting state. Per-order
  size/notional limits and full initial funding remain enforced.
- Stale reservation recovery is permissionless, bounded, returns assets only to
  their rightful beneficiary, and cannot cancel a valid unrelated order.
- The UI binds exact execution and recovery calldata. Stale quotes never silently
  become different executions. Canonical state, liabilities and reorg handling
  remain owned by Ponder and packages/db.

## Implementation and verification checklist

- [x] Vault, delayed delivery, final-state caps, bounded stale recovery.
- [x] Checked quotes, best-price API verification and concurrency guards.
- [x] Database projections, payout reads and reconciliation liability checks.
- [x] API/UI payout withdrawal and explicit stale-order recovery.
- [x] Deployment, ABI/configuration and runtime identity verification.
- [x] Feed shutdown investigation and fix with process-level regression test.
- [x] Contract unit/fuzz/invariant, adversarial concurrency, service/DB/UI tests.
- [x] Local full-stack, real-token Anvil fork, production UI and browser checks.
- [x] Fresh security report with evidence, limitations and unresolved findings.
- [ ] Earlier whole-service 100% coverage requirement (measured gaps remain).

Existing unrelated worktree changes are preserved. No live deployment, user
database migration or upstream transaction is authorized by this implementation.

## Integration and deployment

Market/raw-unit protocol version stays **2**, signed orders stay EIP-712 **3**,
atomic execution is now **2**, reconciliation projection is **3**. These are
different version domains. All contracts must be deployed as one fresh graph.
`ConditionalExchange` creates its non-upgradeable `PayoutVault`; scripts record the
child under the parent creation transaction and verify both runtime identities.
The exchange's vault pointer is constructor-only storage (no setter), so a reference
constructor simulation remains reproducible despite a different CREATE nonce.

Copy `PAYOUT_VAULT_ADDRESS` to the backend/indexer/reconciler environment, and
`NEXT_PUBLIC_PAYOUT_VAULT_ADDRESS` plus `NEXT_PUBLIC_POSITION_ROUTER_ADDRESS` to the
UI build environment. Rebuild the UI after any public address changes. The optional
Cloudflare preflight checks these addresses; normal deployment still skips checks.
Rebuild Ponder into a fresh projection namespace for the new `payout_credit` table
and partial stale-order indexes, keeping the same production PostgreSQL database.
Operational auth/evidence tables are not replaced. No SQLite state is introduced.

Only outstanding payout credits are stored, keyed by beneficiary/asset/token ID.
Full withdrawal deletes the credit row; canonical Ponder rollback restores it if
the withdrawal is reorganized out. Credits are ownership within existing vault
custody, never added to claim supply. Shallow reconciliation compares aggregate
liabilities/backing; deep runs additionally compare beneficiary credits. Old
projection checkpoints cannot clear new-format freezes.

## Recovery interfaces

- `GET /payouts/:account` (indexer/public UI proxy): exact outstanding amounts,
  asset metadata, confirmation label and a 100-row keyset cursor.
- `POST /v1/payouts/withdraw/prepare`: authenticated beneficiary, exact decimal
  uint256 strings `asset`, `tokenId`, `amount`, `recipient`; returns simulated
  wallet calldata, never signs or broadcasts. ERC-20 uses token ID zero.
- `POST /v1/orders/recovery/prepare`: `orderHash` and `kind` of `expired`,
  `invalidated` or `closed`. Permissionless user-paid cleanup; no owner impersonation
  or recipient override. Orders UI exposes expired escrow release; a maker can also
  cancel their own nonce-invalidated/resting orders. Existing RecoveryRouter supports
  larger best-effort batches. Recovery/withdrawal stay available during trading freezes.

All fill accounting and staging finish before recipient callbacks. Only a failed
individual payout becomes a credit; successful legs arrive in the same transaction.
A credit remains the same asset (including branch-specific claims), has no expiry,
and may be withdrawn partially or to another address by that beneficiary. The
admin cannot claim or redirect it. There is no additional protocol withdrawal fee.

The fixed 100,000-gas delivery attempt also defers unusually expensive receivers.
Explicit withdrawal has no such stipend. Issuer-wide pauses, restrictions on
funding/splitting, and unavailable RPCs remain real execution constraints; the vault
does not bypass them. A recipient contract must be capable of authorizing calls to
withdraw its credit. ERC-165 support alone cannot prove that capability. Never choose
a recipient contract you cannot control; exchange/payout-vault/settlement destinations
are rejected at order opening. Recovery transactions consume network gas.

## Quote/concurrency boundaries

The API chooses the best eligible confirmed prices/FIFO and fails closed on pending
new liquidity; the contract does not trust it with ownership or settlement validity.
Checked calls bind exact sequence, rates, makers, remainders, quantities, releases
and an exclusive deadline no later than any selected maker's expiry. A losing
concurrent transaction reverts instead of silently resting with a different plan.
The sequence is not a global onchain best-price proof or an offchain reservation.
External unrestricted callers, reorgs that restore older liquidity, and latency can
still require refresh/cancel/re-place. No server-funded retry or background matcher
is added. Sweeps above 32 makers or cleanup above 32 releases must be split explicitly.

## Additional fixes

- Whole ERC-20 surplus/donations and CTF redemption dust are warning-only, not a
  permissionless trading-freeze trigger. Shortfalls and unexpected CTF claim custody
  remain critical. No surplus can be swept through the beneficiary ledger.
- Polymarket streams coalesce overlapping DB reads and explicitly close/drain
  timers/subscriptions on server shutdown. Late outbound socket opens/messages do
  not restart work after closure.
- Cancellation, payout withdrawal, position merge/redemption and claim-router
  approvals are bound locally in the UI. Position inputs use exact human-unit parsing,
  while contract/API amounts remain raw integers. Demo dispatch receives the same raw units.
