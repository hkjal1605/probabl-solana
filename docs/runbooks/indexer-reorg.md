# Indexer reorg runbook

Ponder automatically detects canonical-chain changes, rolls back handler writes, and replays the
replacement branch. The operational task is to keep downstream state and trading safety aligned
with that canonical projection.

## Normal shallow reorg

1. Ponder rolls affected rows back. Do not restart it or edit its database during convergence.
2. Candidate requests verify their canonical block anchor; an orphaned/mismatched anchor fails closed.
3. Discard outstanding quotes and wait for convergence; no matcher journal or settlement queue needs replay.
4. Wait until `/indexer/health` advances on the canonical branch and head age is normal.
5. Run deep reconciliation. Resume quoting/trading only if no freeze signal exists and direct contract
   state agrees.

Do not broadcast a plan created from orphaned state, even if its order signature remains valid.
Onchain validation and exact maker-remainder checks are the final backstop, not a substitute
for canonical candidate discovery. A user's already-broadcast transaction can still mine;
inspect its canonical receipt and never infer settlement from an HTTP preparation response.

## Deep or finality-violating reorg

Treat any reorg at or below the configured finalized head, repeated cursor oscillation, or an RPC
provider disagreement as a critical incident:

- stop API order preparation and UI submission globally (direct permissionless calls remain possible);
- preserve cancellation, release, merge, and redemption access;
- compare block hashes across independently operated RPC providers;
- retain Ponder/reconciler logs, quoted block identities and wallet transaction receipts;
- identify the common canonical ancestor and perform a clean pinned rebuild;
- require operations/security approval before resuming.

Never lower confirmation/finality settings during an incident to make the service appear current.
Tune them only through a reviewed chain-risk change after Robinhood Chain behavior is measured.

## Recovery evidence

Record the orphaned range and hashes, replacement range and hashes, Ponder recovery point and
head, clean reconciliation report/hash, affected wallet transactions, and operator approvals. If
an onchain fill landed on the canonical branch, it remains authoritative regardless of the old
quote or browser status.
