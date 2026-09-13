# Single MARKET_ADMIN workflow

## Configuration and authority

The API authorizes only the authenticated wallet named by `MARKET_ADMIN`. Legacy operator
lists and separate Safe-address variables no longer grant access. Leave MARKET_ADMIN unset
to disable the admin workflow. Configure the ingestor URL/token, resolution controller and
HTTPS evidence attachment base URL as before; no database migration is needed for this policy change.

The admin UI reads `NEXT_PUBLIC_MARKET_ADMIN_ADDRESS`, or its build-time `MARKET_ADMIN`
alias, and `NEXT_PUBLIC_RESOLUTION_CONTROLLER_ADDRESS` (alias `RESOLUTION_CONTROLLER_ADDRESS`).
These are public addresses, never keys. Set its API_URL and INDEXER_URL to reachable service
origins. The UI never connects to PostgreSQL directly.

The operator prepares an immutable packet, explicitly reviews its checklist and approves it,
then requests a fresh onchain preflight. The same wallet can perform every step. Approval
is not automatic; rejections, evidence integrity, canonical reconciliation, transaction-field
comparison and the exact resolution commitment remain enforced. Losing independent review
concentrates control: compromise or a mistake by this wallet can authorize a bad resolution.

## Existing mainnet deployment

Read-only verification on 2026-09-10, Robinhood chain 4663:

- Authority: `0x6Bba1dDD7173d207dAEb80cbc8F66eeF7B2d8ABb`.
- MARKET_ADMIN: `0x727AD358b6093fF5cBECE5dE7c8aD159aEAbaba0`.
- This wallet holds MARKET_ADMIN_ROLE, but not RESOLUTION_ADMIN_ROLE, GUARDIAN_ROLE or DEFAULT_ADMIN_ROLE.

No Solidity change or redeployment is required. The current protocol owner must call
`ProtocolAuthority.grantRole(keccak256("RESOLUTION_ADMIN_ROLE"), MARKET_ADMIN)` to enable
final resolution from that wallet. This implementation has NOT submitted that transaction,
changed existing mainnet permissions or deployed the API/UI changes. Existing resolution-role
holders retain their rights unless the owner explicitly revokes them. Update the approved role
inventory/manifest when changing grants; deployment verification rejects unexpected role holders.

MARKET_ADMIN already authorizes create, open, freeze, begin-resolution and archive. Resolution
requires the extra role above. Global trading pause/resume requires GUARDIAN_ROLE. Fee changes,
vault governance and owner transfer are separate owner powers; this change does not give them
to MARKET_ADMIN. Do not grant DEFAULT_ADMIN_ROLE merely to enable market resolution.

Fresh deployments may set RESOLUTION_ADMIN=MARKET_ADMIN. Deployment tooling permits only
that role overlap and still separates governance, guardian and temporary deployer addresses.

## UI operation

1. Create market: fetch real metadata, configure raw-unit caps/timing, prepare the packet,
   review/approve in Review queue, preflight, sign and reconcile after indexing.
2. Market controls: open a scheduled market, freeze at cutoff, or submit an authorized emergency freeze.
3. Resolution: select a frozen market, fetch its matching source snapshot, verify the actual
   status, payout and Polygon source CTF address; never use the local Robinhood CTF as Polygon evidence.
4. Approve, execute begin-resolution, reconcile; then preflight and execute resolve-market.
   These are separate transactions. Finalization enables redemption according to the contract.

Public `apps/ui` shows only indexed markets/order books/claims and read-only resolution status.
No fake balance or simulated payout is a fallback. Legacy demo cookies cannot opt back in.

## Verification on 2026-09-10

- 70 scoped API/database/evidence/deployment-policy tests passed through
  `packages/db/scripts/test.ts`, using disposable loopback PostgreSQL, not the production database.
- 54 public UI tests and 9 admin UI tests passed; both optimized Next builds and both UI Biome checks passed.
- 26 Foundry tests passed in `SingleMarketAdminTest`, `ResolutionCommitmentTest`
  and `MarketResolutionAndPositionsTest`. No Solidity runtime source changed.
- UI, admin UI, API, indexer and Polymarket ingestor typechecks passed.
- Playwright checked the real-only public resolution screen, including a stale demo cookie;
  no simulation controls or fake wallet appeared. An isolated test-only upstream supplied its data.
- With test evidence and a non-signing mock wallet, the admin browser required all checklist
  confirmations, allowed the same preparer to approve, and did not enable execution after a
  failed transaction preflight. API/database tests separately exercised persisted authorization
  and evidence transitions; these browser fixtures are not a mainnet end-to-end test.

The full Anvil service stack and a mainnet creation/resolution cycle were not run in this change.
Test fixtures never authorize a mainnet broadcast. The role grant and application rollout remain pending.
