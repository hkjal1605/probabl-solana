# Manual resolution runbook

V1 resolution is intentionally a human-reviewed admin action. No software process should infer or automatically submit the outcome.

1. Freeze the local market and make every unfilled order releasable.
2. Operator A verifies the immutable Polygon chain ID, Polymarket condition ID, YES/NO orientation, and final Polymarket status.
3. Operator A creates an evidence packet containing the local market/condition IDs, exact payout, official references, Polygon transaction/block when available, timestamps, and copied evidence.
4. Operator B independently verifies every field and records approval. Disagreement means no transaction.
5. Prepare the packet with `POST /v1/admin/evidence/resolution/prepare`. Operator B approves every
   required checklist item with `POST /v1/admin/evidence/:packetHash/review`; calculate and publish
   the returned `packetHash` as the `evidenceHash`.
6. Generate `begin-resolution` with `POST /v1/admin/evidence/:packetHash/transaction`, then submit
   the byte-for-byte verified calldata through the market-admin multisig. This moves the market from
   `Frozen` to `AwaitingResolution` with the exact resolution-call commitment as its state-reason
   hash. Derive it with `ManualResolutionController.hashResolution` or the matching domain helper;
   a packet hash alone is not a valid preparation. `bun run market:prepare-resolution` generates
   and simulates this call using the same payout/evidence inputs as `market:resolve`.
7. Wait for Ponder confirmation and reconcile `begin-resolution`. Generate and verify the resulting
   `resolve-market` preview; it must contain the same evidence hash, payout, and source reference.
8. Submit the exact calldata through the dedicated resolution-admin multisig. The API has no signer
   or broadcast route. The older contract CLI remains simulation-only unless `SUBMIT_ADMIN_ACTION`
   is explicitly enabled for an approved local rehearsal.
9. Reconcile the resolution packet against `ResolutionFinalized`, then verify the registry's
   `Redeemable` state, CTF payout numerator/denominator, and direct redemption for both collateral
   types.

Only these vectors are valid:

```text
YES      [1,0] denominator 1
NO       [0,1] denominator 1
invalid  [1,1] denominator 2
```

If Polymarket is disputed, unstable, mismapped, or never resolves, do not improvise a result. Leave the claims unresolved and follow the incident process.
