# ADR-006 — Non-upgradeable v1 contracts

Status: Accepted

## Context

Upgrade keys create a powerful code-replacement path over escrow and redemption.

## Decision

All v1 protocol components are direct deployments with no proxy, delegatecall extension, arbitrary executor, or admin asset recovery. Connections are immutable or set exactly once.

## Alternatives

Transparent/UUPS proxies, diamonds, and mutable strategy modules were rejected.

## Consequences

Bugs require freezing new activity and deploying v2. Old orders must be canceled and old claims remain redeemable through CTF.

## Security assumptions

Deployment bytecode and constructor/configuration transactions are independently verified before use.

## Reversal cost

Upgradeability cannot be added to deployed v1. A future upgradeable system would be a separately disclosed protocol.
