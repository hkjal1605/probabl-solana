# Direct recovery runbook

This runbook does not depend on the API, indexer, or web application.

## Recover an open or partially filled order

- The maker calls `ConditionalExchange.cancelOrder(orderHash)` at any time while it is open.
- If a smart wallet can no longer receive claim escrow, the maker itself may call
  `cancelOrderTo(orderHash, recipient)` to authorize recovery to another address. No third party
  can choose this recipient. Verify that the destination can accept the asset before signing.
- After `expiry`, any address may call `releaseExpiredOrder(orderHash)`; funds always return to the maker.
- After the maker calls `cancelUpTo(newMinimumNonce)`, any address may call `releaseInvalidatedOrder` for an older order.
- After a market leaves `Open`, any address may call `releaseClosedMarketOrder`.
- `OrderRecoveryRouter` provides best-effort batches capped at 64 hashes and 300,000 gas per attempt.
  Supply sufficient total transaction gas for the batch. A gas-consuming receiver is confined to
  its attempt. Wallets needing more gas can use a direct exchange release or maker cancellation.
  Revert data is copied up to 256 bytes; longer data is recorded as `keccak256(abi.encode(fullLength, prefix))`.

The global trading pause does not block these paths. A rejected escrow delivery becomes a
credit for its intended beneficiary in `PayoutVault`; it does not grant the caller ownership.

## Claim a rejected payout

Read `ConditionalExchange.payoutVault()` and verify it against the deployment manifest.
Read `claimable(beneficiary, asset, tokenId)` on that vault. The beneficiary itself calls
`withdraw(asset, tokenId, amount, recipient)`; a smart-wallet beneficiary must execute that
call through its own authorized wallet mechanism. The amount is an exact raw integer,
and may be less than the total credit. For ERC-20 collateral use token ID `0`; for claims
use the canonical Conditional Tokens address and the exact branch-specific position ID.

Choose an address that can receive that asset. A failed withdrawal restores the credit
atomically. Explicit withdrawal has no automatic-delivery stipend and no protocol fee,
but requires network gas and cannot bypass issuer restrictions. No administrator or
third-party caller can withdraw for a beneficiary. A contract that cannot authorize the
call cannot recover its credit through an admin override. The credit has no expiry.

Only the failed payout leg is deferred. The counterparty's successful payouts still arrive
in the original transaction. Vault credits are separate from wallet balances; withdraw
claims before attempting to merge, redeem or use them as order funding.

## Merge before resolution

A holder with equal YES and NO claim amounts may call Gnosis `mergePositions` directly with parent collection `0x00`, the market condition ID, partition `[1,2]`, and the equal amount. `PositionRouter.mergeForUser` is an optional exact-amount convenience path.

Never merge claims reserved by an open order. Cancel/release the order first and confirm the chain event.

## Redeem after resolution

A holder may call Gnosis `redeemPositions` directly for index set `1`, `2`, or both. `PositionRouter.redeemForUser` accepts exact claim amounts so multiple users' balances are never pooled. It is optional and is not a privileged redemption route.

Before signing, verify the chain ID, Conditional Tokens address, collateral token, condition ID, position IDs, and finalized payout event against the deployment manifest and market terms.
