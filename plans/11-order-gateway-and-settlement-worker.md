# Milestone 11 — Order gateway and settlement worker

## Implementation status — 2026-09-04

Implemented in `packages/gateway`, `apps/api`, `services/settlement-worker`, the matcher settlement
adapter, and Ponder settlement APIs. The gateway provides EOA/contract-wallet sessions, exact v1
EIP-712 preparation, safe/latest validation and simulation, funding/payoff previews, roleless relay
with wallet-paid fallback, canonical reads, maker-signed cancel, merge, and redemption, and durable
idempotency/attempt/receipt state. The worker provides a WAL outbox, proposal verification,
confirmed-state validation, cumulative pending checks, explicit nonces, fee replacement, crash
recovery, Ponder-confirmed fill reconciliation, IOC execution plans, and durable failure feedback.

Evidence:

- `docs/architecture/order-gateway-settlement-v1.md`
- `docs/api/v1-orders.md`
- `docs/runbooks/settlement-worker.md`
- `services/settlement-worker/scripts/anvil-e2e.ts`
- `services/settlement-worker/tests/worker.test.ts`
- `packages/contracts/test/Milestone11LifecycleE2E.t.sol`

The local Anvil/Ponder harness passed GTC relay and settlement, duplicate retry, maker cancellation,
two-level atomic IOC, manual YES resolution, and redemption. Foundry acceptance tests cover complete
trade-to-redemption cycles for YES, NO, and invalid payouts. Production deployment still requires
the independent review, exact-chain fee/load tests, secret-manager integration, and rehearsals in
Milestone 14.

## Goal

Connect signed user intent and deterministic matcher proposals to Robinhood Chain without giving backend services custody or authority to violate contract rules.

## Dependencies

- Milestone 09 matcher proposals.
- Milestone 10 canonical projections and reconciliation.

## Order gateway

Implement:

- wallet challenge/session authentication without KYC or eligibility decisioning;
- `POST /v1/orders/prepare` returning exact EIP-712 typed data, funding requirements, approvals, and payoff preview;
- `POST /v1/orders/submit` accepting a signature and funding authorization;
- cancellation preparation/submission;
- IOC/protected-market preparation with explicit worst price and maximum quantity/notional;
- read endpoints for canonical order state from the indexer projection.

Validate before relay:

- chain ID, exchange address, domain version, signer, nonce, salt, expiry, and recipient;
- registered/open market, branch, side, funding kind, tick, step, minimum notional, wallet caps, and market caps;
- balances, ERC-20/ERC-1155 approvals, and exact reservation requirement;
- consistency with contract simulation at the latest safe block.

The contract repeats all enforceable checks. A gateway acceptance is never proof that an order is open; only `OrderOpened` is canonical.

## Idempotency and API state

- Require idempotency keys for submit, cancel, merge, redeem, and relayed admin preparations.
- Persist request digest, order hash, transaction attempts, replacement chain, and final receipt.
- Return application state and canonical chain state separately.
- Make retries safe after timeout, process crash, duplicate client request, or replaced transaction.
- Never store wallet private keys.

## Settlement worker

Consume persisted matcher proposals and:

1. Verify proposal version, input cursor, order state, and pending quantities.
2. Build the exact `matchOrders` or `executeIOC` transaction.
3. Simulate against a configured safe/latest block.
4. Persist a deterministic batch ID and payload before broadcast.
5. Submit using explicit relayer nonce management.
6. Replace underpriced/stuck transactions according to policy.
7. Reconcile receipt and emitted fills through the indexer.
8. On revert, classify the reason, release pending matcher quantities, reload canonical state, and rematch.

The relayer has matcher/fill authority only. It cannot withdraw, resolve, create markets, or change terms.

## Failure behavior

- RPC outage: stop broadcast, preserve proposals, and retry without duplication.
- Simulation disagreement: quarantine the batch and refresh state.
- Revert caused by cancel/expiry: reconcile and rematch remaining valid orders.
- Reorg: wait for indexer rewind/replay before resuming affected books.
- Relayer compromise: guardian stops new fills; users retain cancellation/redeem paths.
- Paymaster failure: offer user-paid order/cancel fallback when supported.

## End-to-end scenarios

Automate at least:

- manually created market through whole/whole YES and NO fills;
- all funding combinations;
- partial fills with price improvement;
- GTC cancel and expiry release;
- protected IOC across several levels and remainder release;
- close, merge, manual admin resolve, and redeem;
- delayed/reverted/replaced fill transaction;
- matcher and worker restart;
- frozen market while fills are pending;
- duplicate API and event delivery.

## Deliverables

- `apps/api` order endpoints.
- Order gateway validation/domain package integration.
- `services/settlement-worker`.
- Relayer key/nonce policy and deployment configuration.
- End-to-end test harness and seeded scenario fixtures.
- API schemas and error taxonomy.

## Exit criteria

- [x] Every accepted order either reaches a canonical state or exposes an actionable failure without duplicate escrow.
- [x] Idempotent retries cannot open, cancel, merge, redeem, or fill twice.
- [x] Settlement worker recovers from reverts, replacements, crashes, and reorgs.
- [x] API previews exactly match contract accounting vectors.
- [x] Relayer permissions cannot move user funds outside valid exchange operations.
- [x] Complete trade-to-redemption E2E tests pass for YES, NO, and invalid resolution.

## Non-goals

- KYC, sanctions, geography, or appropriateness checks.
- Custodial private-key storage.
- Automatic market creation or resolution.
- Matching logic inside the API.
