# ADR-003 — Offchain matching and modular onchain enforcement

Status: Accepted

## Context

An onchain order book is expensive, but offchain custody or settlement would weaken user protections.

## Decision

Use one deterministic authorized matcher. `ConditionalExchange` enforces escrow, limits, sequences, and accounting; immutable helpers isolate signature verification, settlement, and IOC orchestration. All fill effects are atomic.

## Alternatives

Permissionless onchain matching, AMMs, operator custody, and a monolithic exchange were rejected. The monolith also exceeded EIP-170.

## Consequences

Execution is gas-efficient enough for v1 and components remain deployable, at the cost of several external calls.

## Security assumptions

The matcher cannot steal collateral or violate prices but can omit a superior order. Event reconstruction and a shadow matcher detect this venue-level failure.

## Reversal cost

Permissionless matching or committed book roots require a new protocol and service architecture.
