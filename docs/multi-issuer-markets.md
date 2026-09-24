# Multi-issuer markets: one order book, several issuer tokens of one asset

A market (for example "NVDA if YES") has **one USDC quote** and up to
**three base legs**: one whitelisted issuer token of the same underlying stock
per leg (for example xStocks `NVDAx`, Ondo `NVDAon` and Remora `NVDAr`). All
legs trade in **one order book per branch** (YES book, NO book):

- **Bids** pay the market's shared quote claim (USDC-YES on the YES book) and
  carry a bitmask of the legs they accept (default: every listed leg).
- **Asks** deliver exactly one leg's claim, tagged by that leg.
- A bid matches an ask when prices cross **and** the bid accepts the ask's leg.
  The buyer receives that specific issuer's claim.

Claims stay **segregated per issuer**. `NVDAx-YES` is backed only by `NVDAx`.
Split, merge and redeem work per leg. A seller who funds from the underlying
token receives the opposite-branch claim of **their own** issuer, so for a YES
ask of `NVDAon` they get `NVDAon-NO` plus `USDC-YES`. One resolution covers
every leg.

## Asset layout (on-chain)

`collateral c`: `0` = quote (USDC), `1..=bases` = base legs (max `MAX_BASES = 3`).

| asset index | meaning |
|---|---|
| `3c` | underlying of collateral `c` (protocol-wide pool credit, never a wallet balance) |
| `3c + 1` | YES claim of collateral `c` |
| `3c + 2` | NO claim of collateral `c` |

`ASSETS = 12`, `COLLATERALS = 4`. Examples: `0` USDC, `1` USDC-YES, `2` USDC-NO,
`3` leg-1 underlying, `4` leg-1 YES, `5` leg-1 NO, `6` leg-2 underlying, and so on.

Claim mint/vault PDAs are `["claim"|"vault", market, [asset]]` for claim assets.
Underlying custody stays protocol-wide: `pool = ["pool", config, mint]`,
`pool-vault = ["pool-vault", pool]`, `asset-credit = ["asset-credit", pool, owner]`.

`Market` fields that changed: `bases: u8`, `legs: [BaseLeg; 3]`,
`mints/credits/escrow/fees: Vec` (always exactly 12 entries),
`decimals/pool_bumps/backing: [_; 4]` (per collateral), `vaults_initialized: u16`
(bit per asset). `terms.share_decimals: u8` is new.

`BaseLeg { scale: u64, multiplier: u64, active: bool }`:

- `scale = 10^(leg decimals - share_decimals)`.
- `multiplier` holds the IEEE-754 bits of the issuer's effective ScaledUiAmount
  multiplier at listing, or `1.0` if the mint has none.

`Wallet.balances: [u64; 12]`. `AssetPool` adds `admitted: u16` and `vault_bump: u8`.

`OrderTerms.bases: u8` (last field) is the base-leg bitmask, where bit `i` is
collateral `i + 1`. A buy needs a non-empty subset of listed legs. A sell needs
exactly one listed leg.

- **Funding asset of an order:**
  - buy: `funding 0` → `0` (USDC pool credit), `funding 1` → `1 + branch`.
  - sell of leg `c`: `funding 0` → `3c` (leg pool credit), `funding 1` → `3c + 1 + branch`.

## Units

- **Quantities** (`quantity`, `step`, `max_quantity`, plan legs, `remaining`,
  `filled`) are **share units**: `10^-share_decimals` of one economic share.
  The default `share_decimals` is 6, because Backpack uses 6 decimals, xStocks 8 and Ondo/Remora 9.
- **Prices** are quote raw units per share unit × `1e18` (WAD), as before but
  per share unit. **Notional** is `quantity * price / WAD` in quote raw units.
- **Base raw delivered by a fill** of `q` share units on leg `c`:
  `raw = floor(q * scale_c * 2^shift / mantissa)`, where the live multiplier is
  the rational `mantissa / 2^shift` (exact decode of the f64 bits; see
  `protocol_core::base_raw`). Seller reservations round **up**
  (`base_raw(..., up = true)`) at placement. Deliveries round **down**. When an
  ask completes, its leftover reservation is refunded to the seller's funding
  asset in the same instruction.
- **Fees:** the buyer fee is charged on `raw` base claims. The seller fee is
  charged on the quote.
- **Live multiplier:** Token-2022's `new_multiplier` once
  `now >= new_multiplier_effective_timestamp`, otherwise `multiplier`. A mint
  without ScaledUiAmount uses `1.0`.
- **Dividend band:** new exposure on a leg (fills, resting asks, split) requires
  `4/5 <= live / listing <= 5/4`. Dividends reinvested through the multiplier
  stay inside the band. A split or reverse split leaves it and halts the leg.
- **Order reservations:**
  - A sell reserves `base_raw(quantity, scale, live multiplier, up)` raw units of its funding asset.
  - A buy reserves its notional (as before).

TypeScript mirrors of the conversion functions live in `@conditional-stocks/solana-client`
(`multiplierParts`, `baseRaw`, `withinBand`) with test vectors shared with Rust.

## Instructions

| instruction | notes |
|---|---|
| `initialize(roles)` | unchanged (config + quote mint, generic tier only) |
| `initialize_pool(admitted: u16)` | **market admin only.** `admitted` must equal the mint's issuer-control categories exactly |
| `create_market(id, terms)` | accounts: admin, config, quote_mint, quote_pool, quote_vault, market, system_program. Lists the quote only |
| `add_base()` | accounts: admin, config, market, mint, pool, vault, token_program. Lists the next leg (SCHEDULED/OPEN, before cutoff). Emits `Change{kind:15, asset: c, amount: scale}` |
| `set_base(collateral, active)` | guardian may delist; market admin may delist or relist. `Change{kind:16, asset: c, amount: active}` |
| `initialize_claims(collateral)` | creates YES/NO claim mints + vaults of a listed collateral (replaces `initialize_claim` / `initialize_asset`) |
| `lifecycle(0)` open | requires quote claims plus every listed leg initialized, and at least one active leg |
| `split/merge/redeem(collateral, ...)` | `collateral` 0..=bases. Accounts add `underlying_mint` (= pool.mint), drop `system_program`. `credit` must already exist: prepend `initialize_credit` when missing. Split of a base leg requires the leg to be tradable (active, unpaused, unfrozen vault, multiplier in band) |
| `deposit/withdraw(asset)` | claim assets only (`asset % 3 != 0`, listed collateral) |
| `transfer_credit`, `claim_fees(asset)` | claim assets only. `fees` is indexed by asset |
| `cancel` | underlying-funded orders pass their asset-credit frame as the only remaining account. An ask of a delisted leg is publicly releasable |
| `cancel_orders/retire_orders` | up to `count + 4` credit frames (one per collateral pool) |
| `place(terms, plan, participants, delegations, touched: u8)` | see below |

### `place` accounts

Named accounts: `authority, owner, config, market, order, token_program,
system_program, quote_pool, quote_vault, delegation?`. There is no `base_pool` or `base_vault`.

Remaining accounts, in order:

1. Quote claims: `claim(1) mint, vault(1), claim(2) mint, vault(2)`. Writable
   only if some quote-funded (`funding 0`) buyer fills.
2. For each leg in `touched`, in ascending collateral order, 7 accounts:
   `pool, pool-vault, issuer mint, YES claim mint, YES vault, NO claim mint, NO vault`.
   Pool, pool-vault and mint are read-only. Claim mints/vaults are writable only
   if an underlying-funded ask on that leg fills.
3. One maker order per plan leg (writable).
4. `(wallet, trader)` per unique participant (sorted owners). Wallets are writable.
5. Asset-credit frames (writable, unique) for:
   - the taker if `funding 0`;
   - underlying-funded maker **bids** whose fill leaves price improvement
     (existing rule);
   - underlying-funded maker **asks** that complete in this placement with a
     reservation surplus (`reserved - Σraw > 0`).
6. Maker delegation grants (read-only, unique).

`touched` must include the leg of every ask that fills: the taker's own leg
when the taker sells (even with no fills), otherwise each filled maker ask's
leg. Legs of planned makers that end up skipped may stay touched. A resting bid
with no fills has `touched = 0`.

### Plans against a moving book

A plan is `{deadline, next_sequence, min_fill, maker_bps, taker_bps, legs:
[{quantity}]}`. It stays valid while the book moves, so concurrent quoting
never fails a placement:

- **Sequence:** `next_sequence` is the branch sequence the planner observed. It
  must be `<=` the market's current sequence (orders placed since planning
  never invalidate the plan) and every planned maker must be older than it.
  Fee rates must equal the plan's, and `now < deadline`.
- **Makers changed since planning are skipped:** filled, cancelled, retired
  (account closed), expired, nonce-invalidated, grant revoked or expired, or
  re-priced out of the maker fee cap. A partially filled maker is capped to
  what remains. Makers whose settlement would need a pool credit frame the
  transaction does not carry are skipped too: a completing underlying-funded
  ask with a reservation surplus, or an underlying-funded bid with a rounding
  improvement. So is an ask whose reservation no longer covers the live
  delivery.
- **What still fails the placement:** a malformed plan (wrong market, branch or
  side, uncrossed prices, a maker newer than `next_sequence`, a missing
  participant or grant account), fewer than `min_fill` share units filled
  (`StalePlan`), or a plan from a book the chain has not reached. The SDK
  sets `min_fill` to one step for immediate-or-cancel takers and 0 for
  resting orders.
- **No crossed books from races:** the market keeps each branch's last
  `RECENT = 16` placements (`Market.recent`: limit price in ticks and side;
  side 2 if the order did not rest; the sequence is implied by the slot). A placement that rests must not cross an opposite
  resting order placed after its plan, which it could not have matched. If
  it would, or if more than 16 placements happened since its plan, it fails
  with `StalePlan` and the client replans (then matching that order).
  Non-crossing concurrent orders, same-side orders and orders that did not
  rest never conflict.

`StalePlan` is the single retryable error. The API replans delegated
placements on it after its live index reaches the simulated slot.

`Trade` event adds `base: u8` (collateral) and `base_amount: u64` (raw).
`quantity` is in share units.

## Issuer token admission (Token-2022)

A pool's `admitted` bitmask admits issuer controls. The generic extensions
(transfer fee, metadata, groups) stay accepted without admission.

| bit | extension | runtime rule |
|---|---|---|
| 1 | PermanentDelegate | trust decision. A seizure makes that pool fail its solvency checks (isolated per mint) |
| 2 | Pausable | paused ⇒ `IssuerPaused` on custody transfers, `LegHalted` on new exposure |
| 4 | DefaultAccountState | a frozen pool vault cannot be listed or traded (`LegHalted`) until the issuer thaws it |
| 8 | ScaledUiAmount | live multiplier conversion and dividend band |
| 16 | TransferHook | accepted only while `program_id` is unset. Setting a hook ⇒ `TransferHookEnabled` everywhere |
| 32 | ConfidentialTransferMint, ConfidentialTransferFeeConfig | mint config only. Protocol vaults never enable confidential balances or harvest confidential withheld fees |

Mainnet configurations, read on 2026-09-23 (PreStocks and Tessera on 2026-09-25):

| issuer | example | decimals | admitted |
|---|---|---|---|
| xStocks | NVDAx `Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh` | 8 | 63 (all six) |
| Ondo Global Markets | NVDAon `gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo` | 9 | 62 (no PermanentDelegate) |
| Remora | NVDAr `ALTP6gug9wv5mFtx2tSU1YYZ1NrEc2chDdMPoJA8f8pu` | 9 | 47 (no TransferHook) |
| Backpack Securities | SPCX `SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb` | 6 | 63 (no NVDA listed) |
| PreStocks | OPENAI `PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF` | 9 | 63 (plus a 1–3% transfer fee and its confidential fee config) |
| Tessera | tOpenAI `oPAiAikWTaFj9RYoRFD35ccfwhnMcB3ThgBZRHSkjTZ` | 9 | 0 (generic fee token, 0.2% transfer fee) |

- Accepted mint default account state is `initialized` for all of these.
- Securitize (SECZ) and Superstate (GLXY) default to frozen. Their pool vaults
  need issuer allowlisting and a thaw before they can be listed.

## Errors added

`LegHalted`, `IssuerPaused`, `TransferHookEnabled`.

## TypeScript SDK (`@conditional-stocks/solana-client`)

- **Layout helpers:** `MAX_BASES`, `COLLATERALS`, `ASSETS`, `QUOTE`, `LEG_ACCOUNTS`,
  `underlyingAsset(c)`, `claimAsset(c, branch)`, `collateralOf(asset)`,
  `isClaimAsset(asset)`, `legBit(c)`, `legsOf(mask)`, `allLegs(bases)`,
  `singleBase(mask)`.
- **Math:** `multiplierParts`, `multiplierBits(number)`, `multiplierValue(bits)`,
  `baseRaw(units, scale, multiplierBits, up)`, `withinBand(listing, current)`,
  `shareScale(legDecimals, shareDecimals)`, `UNIT_MULTIPLIER`.
- **Orders:**
  - `OrderWire.bases` (mask) is required.
  - `orderCollateral(order)`, `fundingAsset(order)`, `acceptsLeg(order, c)`.
- **Tokens:**
  - `decodeSupportedMint(address, info, admitted = 63, now)` accepts issuer
    controls and returns `.issuer` (`controls`, `paused`,
    `transferHookProgram`, `multiplier`, `nextMultiplier`, `defaultFrozen`).
  - `issuerState(tlv, now)`, `assertTransferable(mint)`, `ISSUER_CONTROLS`,
    `ALL_ISSUER_CONTROLS`.
- **Live legs:**
  - `legAccounts(market, config, program)` lists the accounts to read (leg
    mints, then leg pool vaults).
  - `legStates(market, infos, config, program, now)` and `liveLegs(connection, market, config, program)`
    return `Record<collateral, LiveLeg>`: `tradable`, `halt` (`"delisted" |
    "claims-uninitialized" | "issuer-paused" | "vault-frozen" | "corporate-action" |
    "transfer-hook" | "unreadable" | null`), `multiplier` (bits),
    `multiplierValue`, `scale`, `decimals`, `mint`, `active`, `ready`, `paused`,
    `vaultFrozen`. Use it for planning, display and market-maker gating.
- **Planner:**
  - `planOrder({..., legs?: Record<c, LegState>, maxMakers?})` filters by leg
    acceptance and tradability, and skips asks whose `Candidate.reserved` cannot
    cover the live conversion.
  - It returns `plan.surplus` (a boolean per maker) when every ask's reserve is known.
  - It returns `plan.minFill`: one step for immediate-or-cancel takers, else 0.
    `expectedRemaining` is kept for credit-frame decisions and review only; it
    is not sent on chain.
  - Pass `legs` from `liveLegs` and `reserved` from the indexed order.
- **Placement and positions:**
  - `SolanaClient.placement(order, plan, market)` builds the new layout.
  - `positionCredit(market, owner, c)` is the idempotent `initialize_credit`
    that must precede split/merge/redeem. `positionTransaction` and
    `redemptionTransaction` prepend it automatically.
- **Custody:** `deposit`/`withdraw` with an underlying asset (`3c`) route to the
  protocol pool. Claim assets use the market vault.
- **Maintenance:** `orderMaintenance(kind, market, owner, orders, refundAssets)`
  takes underlying asset indexes (`0, 3, 6, 9`) for credit frames.
- **Admin (`@conditional-stocks/solana-client/admin`):**
  - `evidenceTransaction` for create-market (quote only).
  - `initializeMarketVaults(client, market, payer, baseTokens)` returns the
    ordered listing txs (pool + `add_base` per missing leg), then the
    `initialize_claims` txs.
  - `addBaseTransaction`, `setBaseTransaction`, `mintAdmission`, `marketIdFromConfig`.
- **Evidence:** creation evidence is `schemaVersion: 4`. `config.baseTokens: string[]`
  (1..=3, ordered, distinct, ≠ quote) replaces `baseToken`, and
  `config.shareDecimals` is new. `baseStep` and `maxOrderQuantity` are in share units.
- **Fixtures:** `encodeAccount(name, value)` replaces
  `coder.accounts.encode`, whose fixed 1000-byte buffer is too small for Market.

## Indexed JSON contract (indexer → API → UI), `protocolVersion: 3`

Market (`marketView`):

```jsonc
{
  "id": "...", "createdAt": null, "conditionId": "...",
  "polymarketConditionId": "0x..", "polymarketYesIndex": "1", "polymarketNoIndex": "2",
  "rulesHash": "0x..", "metadataHash": "0x..", "metadataUri": "...", "state": 2,
  "tradingOpen": "...", "tradingCutoff": "...",
  "priceTickRawX18": "...",          // quote raw per share unit x 1e18
  "baseStep": "...",                 // share units
  "minNotional": "...", "maxOrderQuantity": "...", "maxOrderNotional": "...",
  "maxWalletOpenNotional": "...", "maxMarketOpenNotional": "...",
  "quoteToken": "<mint>", "quoteTokenDecimals": 6,
  "shareDecimals": 6,
  "quoteClaimMints": { "yes": "<mint>", "no": "<mint>" },
  "bases": [
    {
      "collateral": 1, "bit": 1, "mint": "<issuer mint>", "decimals": 8, "scale": "100",
      "listingMultiplier": "<u64 f64-bits decimal>", "active": true, "ready": true,
      "claimMints": { "yes": "<mint>", "no": "<mint>" },
      // live issuer state from the streamed mint and pool vault (indexer / API):
      "live": { "multiplier": "<bits>", "multiplierValue": 1.0017, "paused": false,
                "vaultFrozen": false, "tradable": true, "halt": null }
    }
  ],
  "claimMints": ["<12 asset mints; unlisted = 11111111111111111111111111111111>"],
  "protocolVersion": 3, "priceFormat": "share-unit-ratio-x18"
}
```

- **Orders:** indexed orders carry the wire `bases` mask, plus `reserved`, which
  is raw units of the funding asset. For a sell, `baseCollateral` is the
  delivered leg.
- **Order-book levels:** `{ branch, side, limitPriceRawX18, remaining, byBases: { "<mask>": "<remaining>" } }`.
  Asks always use single-bit masks (one issuer). Bids use their accepted-leg
  masks. `remaining` is the level total in share units.
- **Positions:** `{ marketId, conditionId, redeemable, shareDecimals, quoteTokenDecimals,
  quoteYes, quoteNo, bases: [{ collateral, mint, decimals, yes, no }], protocolVersion: 3 }`.
  Claim amounts are raw units of their own mint.
- **Trades:** Trade events carry `base` (collateral) and `baseAmount` (raw).
  `quantity` is in share units.
- **Commitment:** trading reads (`/markets`, `/orderbook(s)`, `/orders`,
  `/stream`) serve the confirmed view. Orders and trades carry
  `confirmation: "confirmed" | "finalized"`, and `/trades` lists confirmed,
  not-yet-final trades first. `/health` reports `head.confirmedBlock`,
  `head.finalizedBlock` and `streamLagMs`. Custody reads (`/balances`,
  `/positions`, `/payouts`, `/resolutions`, `/reconciliation`,
  `/markets/:id/leg-events`) serve the finalized view.

## Known limitations (by design)

- **Falling multipliers can strand older asks.** A multiplier that falls while
  staying inside the band can leave an older ask unable to cover its live
  delivery. The SDK planner skips such asks. The owner can cancel them, but
  they are not publicly releasable.
- **The listing multiplier is fixed for the life of a market.** A split, or
  cumulative dividends above 25%, halts that leg until resolution. Rebasing
  mid-market would silently reprice resting bids.
- **A buyer's fee remainder carries across legs.** The fee carry is per
  order. Its effect is less than one raw unit per fill and has no solvency impact.
- **A seizure blocks every position path on that leg.** A permanent-delegate
  seizure makes that pool fail its solvency checks, which blocks split, merge,
  redeem and withdrawal on that leg only. Other legs and markets are unaffected.
- **Large fills need the lookup-table keeper.** See "Fill capacity" below.
- **The planner, not the program, chooses makers.** A plan may skip better
  newer orders (price-time priority holds for the book the planner saw). A
  client that plans against a stale or partial book cannot rest crossed
  against orders placed after its plan (see "Plans against a moving book").
  Orders older than its plan are its planner's responsibility, as before.

## Fill capacity: how many makers one trade can fill

One `place` transaction fills up to `MAX_MAKERS = 8` resting orders. That
transaction must fit Solana's 1232-byte packet and 64-account lock limit.
Measured with `packages/solana-client/test/capacity.test.ts` and
`capacity-validator.test.ts` (8 distinct makers, 1 or 3 legs):

| Lookup tables used | Makers per trade | Binding limit |
|---|---|---|
| none | 1 | packet: every maker adds about 115 bytes (order, wallet and trader keys) |
| frozen deployment table (static market accounts) | 5 | packet |
| deployment table + keeper participant tables | **8 (protocol maximum)** | none: 48–62 accounts, ≤ 419k CU |

The mainnet and devnet account-lock limit is still 64: the "increase tx
account lock limit to 128" feature is inactive.

**The keeper** (`services/solana-indexer/src/lookup-keeper.ts`) fixes the
packet limit.

- **What it appends:** every market's static accounts, plus every participant
  of a live order: the owner and the recipient's wallet, trader, pool credit
  frames and delegation grants.
- **How it appends:** only to append-only lookup tables it owns, and it records
  them in `solana_lookup_tables`. Existing entries never change and tables are
  never deactivated, so an index a client compiled against stays valid.
- **Spam and cost limits:** only live-order participants are added, because
  resting an order reserves collateral. A daily address budget
  (`SOLANA_LOOKUP_KEEPER_DAILY_ADDRESSES`, default 20,000) and a
  per-pass transaction cap bound the rent the keeper spends.
- **Pre-registered market makers:** `SOLANA_LOOKUP_KEEPER_OWNERS` lists
  `owner[:delegate...]` entries (comma or whitespace separated). Their wallet,
  trader, pool credit and grant PDAs are appended for every market right after
  the market's static accounts, without waiting for a live order. So takers
  can fill a professional maker's very first quotes, 8 per transaction, as
  soon as the quote lands. They count toward the daily budget: about 7
  addresses per maker per market.
- **Operate:** set `SOLANA_LOOKUP_KEEPER_KEYPAIR` to a funded keypair file for
  the indexer. A full 256-address table costs about 0.058 SOL of rent.
- **Consumers:**
  - The API refreshes the table list every 5 s, sizes and sends placements
    with it, returns it in `POST /v1/orders/prepare` as `lookupTables`, and
    serves it at `GET /v1/lookup-tables`.
  - The UI wallet and the market maker fetch that endpoint.
  - The SDK (`client.useLookupTables`) reads keeper tables at `finalized`, so
    only rooted entries are referenced.

**Orders that still cross more makers than fit** (more than 8, or a rare
worst case over 64 accounts):

- An immediate-or-cancel order fills as many makers as one transaction carries
  and releases the rest, matching its on-chain semantics.
- A resting (GTC) order is rejected with the per-transaction limit, rather
  than resting a remainder that would cross the book.
