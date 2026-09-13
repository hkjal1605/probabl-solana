# ADR-005 — Manual resolution without cross-chain automation

Status: Accepted

## Context

The controlling condition settles on Polygon, while user claims live on Robinhood Chain. V1 does not have a sufficiently reviewed bridge/proof design.

## Decision

Only `RESOLUTION_ADMIN_ROLE` manually submits YES, NO, or invalid 50/50 after two-person verification. The controller records evidence and reports once to local CTF. No watcher, attestation network, bridge, or API can settle a market.

## Alternatives

API automation, signer committees, optimistic proposals, light clients, and bridge messages were deferred.

## Consequences

V1 has a disclosed centralized factual-resolution trust assumption.

## Security assumptions

A compromised resolution multisig can submit the wrong allowed vector. Caps, separation, evidence, and multisig reduce but do not remove this risk.

## Reversal cost

Automation is a new oracle adapter and protocol version requiring separate audits.
