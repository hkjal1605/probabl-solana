# ADR-010 — No KYC or identity gating in v1

Status: Accepted pending later legal review

## Context

The product owner chose to consult counsel before designing identity, jurisdiction, or transfer restrictions.

## Decision

V1 contains no KYC/KYB, sanctions, geography, appropriateness, investor-status, wallet-allowlist, compliance-provider, or identity field in contracts, orders, APIs, or services.

## Alternatives

Onchain allowlists, transfer-restricted claims, hosted-wallet gating, and provider integrations were deferred rather than partially implemented.

## Consequences

Wallet caps are not unique-person limits. Legal approval remains an external launch gate and may limit whether v1 can be offered.

## Security assumptions

No operational document describes wallet-level caps as Sybil-resistant or implies legal clearance.

## Reversal cost

Later gating may require new contracts/order schemas and migration. It must not strand redemption of already issued v1 claims.
