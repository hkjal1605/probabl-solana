# Maker/taker fees and fee vault

Scope: maker/taker fees only. Redemption, merging, cancellation, recovery, and price improvement remain fee-free. The pinned Gnosis Conditional Tokens implementation is unchanged.

## Fee rules

- `ProtocolFeeVault` starts with `makerFeeBps = 0` and `takerFeeBps = 0`.
- The current `ProtocolAuthority.DEFAULT_ADMIN_ROLE` holder can call `setFeeRates(uint16 makerBps, uint16 takerBps)` at any time. There is no fee-update timelock. Both rates are bounded to 0–1,000 bps (10%). The cap is a compiled safety limit, not an admin-adjustable setting.
- Rates apply at execution, not order placement. Both rates are snapshotted before token callbacks for each fill. An update never reprices an earlier fill.
- Maker/taker status comes from the exchange's existing onchain order sequence, not the signer field named `Order.maker`, side, or GTC/IOC label. A GTC order can take initially and make later; each fill uses its actual role.
- Each order signs `uint16 maxFeeBps`. Either applicable rate exceeding that cap reverts the entire match; the caller cannot waive it or overwrite the signed cap. Cancellation and recovery still work. A zero cap authorizes zero fees, even after an admin increase.
- Fees are deducted only from received **active claims**: stock claims for buyers; USDG claims for sellers. Funding reservations remain unchanged and no extra USDG approval or balance is needed.
- The other side's funding amount, inactive claims, and buyer price-improvement refund are not reduced. Gross fill quantities/prices remain the accounting basis for open-order reservations and risk caps.
- Received claim balances are exact raw amounts and need not align with an order's `baseStep`. Do not round those balances; the step restriction applies to new submitted order quantities.

These are percentages of received claim units, not percentages of the probability or a profit calculation. A 25 bps maker buyer receiving 1 gross stock claim gets 0.9975 claims and the vault gets 0.0025. A 75 bps taker seller receiving 100 gross USDG claims gets 99.25 claims and the vault gets 0.75. These claims remain conditional; they are not immediately realized stock/USDG revenue and losing claims redeem for zero.

## Math and rounding

For each signed order, settlement retains a remainder smaller than 10,000:

```text
fee, nextCarry = divmod(grossReceivedRaw * applicableFeeBps + priorCarry, 10_000)
netReceivedRaw = grossReceivedRaw - fee
```

Implementation uses OpenZeppelin `Math.mulDiv` plus `mulmod`; it never computes an overflowing 256-bit product. The combined fractional term is at most 19,998. The stored `uint16` cast follows a modulo operation, so it is bounded to 0–9,999. With the maximum 10% rate, the computed fee never exceeds the current gross amount, including a carried fractional unit.

Carry is shared across maker/taker fills and rate changes of the **same order**, but never across different orders or assets. Thus total fee equals `floor(sum(gross_i * rate_i) / 10_000)`. Fragmenting a fill cannot repeatedly round the fee upward or discard the fractional fee on every fragment. Setting the rate to zero retains the prior carry without charging anything. Unused sub-unit carry after a terminal order is not collected: the user-favoring difference is less than one raw received-claim unit per order. Splitting into different tiny orders can therefore avoid sub-unit fees; no minimum raw-unit fee is imposed.

At zero rates there are no fee transfers, no fee remainder writes, and no fee-charge events. At nonzero rates, zero fee amounts also do not generate fee-charge events. Zero-rate execution still reads the immutable vault's packed settings and checks the signed caps; it is not identical in gas cost to the pre-fee exchange.

## Vault and administration

Deploy `ProtocolFeeVault(ctf, authority)` before settlement. Deploy `ConditionalSettlement(ctf, registry, exchange, feeVault)`; settlement verifies the vault's CTF and authority match the registry. The vault reference is immutable. Normal deployment and verification scripts include the vault and verify its runtime and wiring.

The vault's canonical ERC-1155 balances are its ledger. There is no duplicate balance map to desynchronize and no unbounded accrual counter. It accepts only the configured CTF's receiver callbacks. Deliberate donations of those claims are accepted and belong to the treasury as well.

Admin entrypoints:

| Function | Result |
| --- | --- |
| `setFeeRates(makerBps, takerBps)` | Update both rates immediately; 0 disables a rate |
| `feeRates()` | Read both current rates |
| `claimFees(recipient, positionIds, amounts)` | Transfer up to 64 entries of the vault's earned claims before or after resolution |
| `redeemFees(collateralToken, conditionId, indexSets, recipient)` | Redeem the vault's resolved binary claims and forward the resulting collateral |

`redeemFees` is a treasury convenience method, **not a redemption fee**. It burns only claims owned by the vault. A claim may instead be withdrawn and redeemed directly from the treasury wallet. Neither method has access to exchange reservations or anyone else's CTF claims. There are no arbitrary calls, token spending approvals, upgrades, or escrow withdrawal powers. Outgoing asset operations are reentrancy-guarded; a failing recipient or collateral transfer reverts the complete withdrawal/redemption.

The existing delayed authority handover also transfers fee administration. Market, guardian, and resolution roles alone do not authorize fee updates or claims. Use the final default-admin wallet/multisig, not an operational service key.

For example, submit a transaction to the deployed vault with `setFeeRates(0, 20)` for 0% maker / 0.20% taker, or `setFeeRates(0, 0)` to disable both. Obtain the exact vault address from the deployment manifest's `ProtocolFeeVault` record or `ConditionalSettlement.feeVault()`. Rates do not require new `.env` configuration; they are onchain state.

## Signing and application integration

Order EIP-712 version is **3** with `maxFeeBps` appended after `salt`. Market identities and raw-unit pricing remain protocol v2: do not change market IDs or rescale any amounts. Pre-fee v2 signatures are not valid v3 signatures, including at zero rates.

Shared types, ABI bindings, golden vectors, gateway parsing/preparation, atomic candidate planning and execution-plan serialization, indexer order projections, development seed scripts, and UI signing carry the cap. An omitted gateway/UI cap defaults only to zero, never to the protocol maximum. The UI lets the user explicitly authorize a higher cap and labels payoff previews as before fees; API preparation includes that same fee-basis distinction. Current admin rates are not inferred from that maximum.

`OrderOpened` includes the cap. `TradingFeeCharged` records the order, market, received position ID, liquidity role, rate, gross amount, and actual fee. The indexer accumulates only per-order `feesPaid` in received-claim units for order history; canonical CTF transfers already provide wallet/vault balances and reorg-aware collateral reconciliation. There is no second per-transfer balance database. Reverted transactions produce neither fees nor canonical fee records.

Use a fresh deployment and regenerate/reindex development state against its ABI/start block. Do not replay old signed intents or old orderbook snapshots as v3 orders. No deployed old contracts were assumed or migrated here.

A rate increase can make resting low-cap orders unfillable. They must be cancelled/re-signed, or wait for rates to fall. This is deliberate protection, not permission to raise a signed cap. The atomic candidate query filters maker fee eligibility before its row limit, and preparation rejects fills above the taker's cap. Current rates are read at one latest-chain block. Rates can still change between quoting and inclusion; exact simulation and onchain signed-cap checks remain authoritative.

## Open-source research and design choices

Reviewed 2026-09-08 using primary repositories:

- [Polymarket CTF Exchange trading](https://github.com/Polymarket/ctf-exchange/blob/main/src/exchange/mixins/Trading.sol) deducts fees from received proceeds; [signed order fields](https://github.com/Polymarket/ctf-exchange/blob/main/src/exchange/libraries/OrderStructs.sol) bind fee authorization. This informed claim-side deductions and signature-bound consent. Our cap permits live admin rates below the signed maximum.
- [Polymarket fee bounds](https://github.com/Polymarket/ctf-exchange/blob/main/src/exchange/mixins/Fees.sol) use a 1,000 bps maximum. We adopted that safety ceiling. Its probability-based [calculator](https://github.com/Polymarket/ctf-exchange/blob/main/src/exchange/libraries/CalculatorHelper.sol) was **not** copied: probabl prices are raw stock/quote ratios, not probabilities bounded by one.
- [Uniswap v3 protocol collection](https://github.com/Uniswap/v3-core/blob/main/contracts/UniswapV3Pool.sol) separates fee accrual from authorized collection. We did not adopt wrapping narrow accrual counters or retaining a final unit for storage-gas reasons.
- [Uniswap TokenJar](https://github.com/Uniswap/protocol-fees/blob/main/src/TokenJar.sol) demonstrates an isolated passive fee destination with authorized release. Our vault is an independent implementation specialized to the protocol's canonical ERC-1155 claims, with no arbitrary-call machinery or copied TokenJar code.

This choice prioritizes a small custody boundary and no duplicated balances. A separate vault is not universally the cheapest per-trade option: it adds ERC-1155 transfers when fees are charged, in exchange for keeping treasury withdrawal authority completely outside user escrow. No claim of globally optimal gas cost is made.

Tests include overflow boundaries, independent arithmetic references, all branch/funding/maker combinations, mixed token decimals, partial fills, taker-to-maker role changes, live fee changes, zero/signed caps, signatures, IOC remainders, failures and callbacks, withdrawal authorization, vault resolution, and fee-enabled stateful conservation. Local deployment rehearsal additionally verifies actual v3 TypeScript signatures and transactions against deployed bytecode. These checks are not a third-party audit or a formal verification proof.
