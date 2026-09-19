# Solana compute, rent, and execution-capacity audit

Date: 2026-09-18. Source revision: `4b1dafded87155a1f3574fdb5cd9043199583c09`.

Follow-up: see [the remediation implementation and rollout notes](solana-cost-remediation-2026-09-18.md). Measurements below preserve the original pre-change baseline.

## Conclusion

The program is **not yet cost- or capacity-optimized**. The most important findings are not tiny arithmetic improvements:

1. A valid two-distinct-maker, whole-funded fill exhausts the compiled program's heap. Increasing compute units does not solve this.
2. Every order creates a permanently retained account, including immediate-or-cancel orders with no fills. Rent grows with lifetime order count rather than live liquidity.
3. Settlement repeats account identity derivation and token mint CPIs that can be consolidated without weakening collateral checks.
4. The current client cannot reliably use the program's advertised eight-maker bound: transaction bytes and heap are separate limits.

No production program, SDK, deployed account, or live funds were changed during this audit. A local SBF diagnostic test was added. This is an optimization-oriented source review and targeted executable investigation, not a formal proof, independent security certification, or assurance that no other vulnerabilities exist.

## Scope and method

Read all production Rust in `programs/conditional-stocks/src/`: `lib.rs`, `state.rs`, `governance.rs`, `custody.rs`, `exchange.rs`, `invariants.rs`, and `token_policy.rs`; also the entire `crates/protocol-core/src/lib.rs`. Reviewed every public instruction and its internal accounting/validation helpers. Read the six existing integration/property test modules, release configuration, and relevant SDK transaction-building/planning paths. Selected relevant modules—not entire repositories—from MetaDAO, Phoenix, and OpenBook were read for comparison.

Built fresh SBF offline using the installed `cargo-build-sbf` 3.1.10 / platform-tools v1.52 and the repository's locked dependencies. The artifact is 690,840 bytes, SHA-256 `1b8b3fa1ce785b47618eb712b88613ca472fa21db6ec9f6a399db63e182540e1`. It matches the existing local `target/deploy/conditional_stocks.so`; this does **not** establish that the live deployment contains the same binary.

Measurements use `solana-program-test` 3.1.9 executing compiled SBF, deterministic synthetic accounts, classic SPL collateral, six-decimal fixtures, nonzero fees, and a 1,400,000-CU transaction limit to distinguish memory failures from compute exhaustion. They are local measurements, not live-network fee quotes or worst-case bounds. Metadata length, PDA bumps, recipients, funding mode, Token-2022 extensions, and runtime version can affect results.

## What “gas optimization” means here

Solana separates per-signature transaction fees from optional priority fees. For the v0 transactions this client builds, priority fees depend on the **requested compute limit**, not actual consumed units. Lower actual CU does not automatically reduce a zero-priority-price transaction's base fee. It improves execution headroom and can support a smaller requested limit when priority fees are enabled. [Solana fees](https://solana.com/docs/core/fees)

Account storage needs a minimum SOL balance. This is generally refundable on safe account closure, not a recurring gas charge. Our program does not provide closure for order tombstones, so their deposits are effectively locked under the current implementation. [Solana accounts](https://solana.com/docs/core/accounts)

There are four separate optimization targets: transaction fees, locked rent, execution resources (compute/heap/packet size), and write-lock contention.

## Measured baseline

CU includes the single explicit compute-budget instruction. Successful rows are complete simulated transactions; failure rows must not be interpreted as successful execution costs.

| Operation | CU | Result |
| --- | ---: | --- |
| Place a resting whole-funded order | 93,801 | Success |
| IOC with no fills | 96,018 | Success; still creates an Order |
| One maker, both sides whole-funded | 148,608 | Success; 4 mint CPIs |
| One maker, both sides claim-funded | 118,888 | Success; 0 mint CPIs |
| One maker, mixed funding | 133,764 | Success; 2 mint CPIs |
| Two distinct makers, both sides whole-funded | 198,046 before failure | Heap exhaustion after 8 mint CPIs |
| Two distinct makers, both sides claim-funded | 143,825 | Success |
| Two distinct makers, mixed funding | 173,600 | Success |
| Two orders from one maker, whole-funded | 197,097 | Success |
| Four distinct makers, whole / claims / mixed | 187,695 / 143,288 / 167,465 before failure | Heap exhaustion; LUT used to isolate runtime |
| Eight distinct makers, whole / claims / mixed | 191,836 / 171,675 / 192,103 before failure | Heap exhaustion; LUT used to isolate runtime |
| Four orders from one maker, whole-funded | 178,034 before failure | Heap exhaustion |
| Eight orders from one maker, whole-funded | 170,124 before failure | Heap exhaustion; LUT used |
| Split | 65,806 | Success |
| Merge | 66,206 | Success |
| Redeem INVALID, equal YES/NO quantities | 66,785 | Success |
| Permissionless cancel after freezing | 19,394 | Success |
| Bounded classic-SPL deposit | 28,102 | Success |
| Bounded classic-SPL withdrawal | 29,261 | Success |

Token-2022 transfers and governance instructions were source-reviewed but not CU-benchmarked here. Resting placement with a 512-byte metadata URI used 94,038 CU, only 237 more than the short-URI fixture: do not prioritize a large metadata-layout migration on speculative CU savings alone.

### Account rent

Sizes include Anchor's discriminator. SOL figures use the pinned runtime's `Rent::default()`, not an RPC rent quote.

| Account | Data bytes | Rent-exempt SOL |
| --- | ---: | ---: |
| Config | 246 | 0.00260304 |
| Market | 1,825 | 0.01359288 |
| Wallet, per owner/market | 137 | 0.00184440 |
| Trader, per owner/config | 81 | 0.00145464 |
| Order, per unique salt | 226 | 0.00246384 |
| Classic SPL mint | 82 | 0.00146160 |
| Classic SPL token account | 165 | 0.00203928 |

A classic-SPL market's Market + four claim mints + six vaults requires approximately **0.03167496 SOL**, excluding configuration, users, underlying mints, and transaction fees. Token-2022 vault extension sizes can increase this.

Ten bids and ten asks on each of two branches means 40 Order accounts: **0.09855360 SOL**. Replacing that entire set creates another 40 accounts. At current sizes, 1,000 lifetime orders lock **2.46384 SOL**; 100,000 lock **246.384 SOL**, even if all orders have completed or been cancelled.

## Findings and recommendations

### COST-01 — High: supported matching workloads exhaust heap

Location: `exchange.rs::place`, dynamic account parsing, settlement loop, and serialization.

The two-distinct-maker whole-funded fixture fits the current v0 packet limit (1,146 bytes), supplies 1.4M CU, and fails with an allocation/out-of-memory log and `ProgramFailedToComplete`. It was also submitted to the local bank, not only simulated. All writable nonpayer accounts—including token accounts, mints, wallets, market, maker orders, and the new taker order—were compared before/after and unchanged. This is an availability/failed-fee problem, not evidence of partial settlement or lost collateral. Transaction fees can still be charged on failure.

The existing shared-maker regression does not exercise this topology. Four- and eight-maker fixtures fail in additional funding configurations. These are concrete failing cases, not a claim that every transaction at those counts fails.

The pinned `solana-program-entrypoint` allocator has a 32-KiB heap and no-op deallocation. The program uses allocating `BTreeMap`, `BTreeSet`, vectors, CPI construction, and Anchor event serialization. These are candidate contributors; the audit did not attribute individual allocation bytes. CU limits and heap capacity are distinct. Merely adding `RequestHeapFrame` does not resize this default allocator's fixed arena.

Recommended implementation:

- Use a single bounded participant table with owner, nonce, wallet, and account index rather than separate trees; use bounded duplicate checking and owner lookup. With the existing small protocol limits, linear scans may beat tree allocations, but benchmark them.
- Retain checked bounds before allocating/decoding, participant deduplication, alias-safe shared-wallet mutations, and exact PDA/owner checks.
- Avoid redundant wallet deserialization at write-back; retain the validated account-to-owner mapping.
- Aggregate mint CPIs as in COST-04; investigate fixed-size event encoding only if profiling still justifies it.
- Do not move all buffers onto one large stack frame. A reviewed larger custom heap is an alternative only if necessary, with explicit runtime heap requests and tests.

Acceptance: successful compiled-SBF execution across 0/1/2/4/8 legs, distinct/shared/self owners, distinct recipients, both branches, all funding combinations, maximum metadata, and adverse PDA bumps; negative paths must remain atomic. Unsupported packet shapes need early client rejection. The new profiler is diagnostic and intentionally records known OOM cases—it is **not** a regression suite asserting those cases succeed.

### COST-02 — High economic impact: permanent per-order rent

Locations: `exchange.rs::Place` unconditionally initializes Order; `state.rs::Order` explicitly retains tombstones; `cancel` releases credit but not rent.

This dominates repeated market-maker quoting costs. Even no-fill IOC placement pays for an account that cannot later be reclaimed through the current program.

Prefer a versioned reusable per-trader order-slot/page model, or a carefully designed closable-order model with durable replay protection. A non-resting IOC path can potentially avoid a persistent Order entirely, but needs explicit application-intent replay semantics. Historical fills belong in canonical indexed history; history alone is not on-chain replay protection.

**Do not simply add `close` to filled/cancelled orders.** Their existence currently prevents reusing an owner/market/salt identity. Slot generations, durable nonce rules, stale signed requests, cancellation, partial fills, recipient ownership, exposure, and existing indexer identifiers must be designed together. Trader nonce state must not become resettable by closing/recreating it.

This needs a contract/state/SDK/indexer migration. Safe terminal Wallet cleanup is a smaller separate opportunity, but requires zero credit, zero reservations/exposure, and preservation of replay state. Do not close market/claim accounts while external claims still exist.

### COST-03 — Medium: repeat PDA searches and immutable validation

Locations: `invariants.rs::read_claim`, position snapshots in `custody.rs`, pre/post snapshots in `exchange.rs`.

Each claim read calls `find_program_address` for mint and vault. A placement reads four pairs before and after: **16 searches in this helper alone**. Position operations read two pairs twice: eight. Additional Anchor vault/order constraints perform derivations too.

The market already stores registered mint addresses. Validate identity once against trusted initialized state, cache validated account identities for the instruction, and reread only mutable supply/balance fields after CPI. Vault bumps can be persisted for fixed-bump derivation in a versioned layout, or derive once per instruction without migration.

Do not remove fresh post-CPI balance/supply reads, independent expected-delta checks, owner/program checks, mint authority validation, external-supply backing, or vault solvency checks. This is deduplicating immutable validation, not caching collateral across transactions. Measure savings before assigning a percentage.

### COST-04 — Medium: consolidate per-fill mint CPIs

Locations: `exchange.rs::settle_asset`, `custody.rs::mint_claim`.

Whole-funded fills mint both outcome claims for each collateral leg. N fully whole-funded fills currently need up to **4N mint CPIs**. The instruction already computes independently checked `expected_minted[4]` totals.

Process per-fill accounting and fees in order, accumulate checked mint totals, then mint once per affected claim before fresh post-CPI checks: **at most four mint CPIs**. At eight fills this is 32 to four CPIs, not a promise of an 87.5% total-CU saving. Claim mints are program-controlled classic SPL, so this proposal does not assume arbitrary Token-2022 hook behavior.

Preserve per-order fee carry, price-improvement rounding, inactive-branch credit ownership, shared-owner/self-match handling, caps, and independent deltas. Never round fees after aggregating trades. Differential tests against the existing arithmetic are required.

### COST-05 — Medium: general placement path charges simple orders for full settlement machinery

Resting orders use about 94k CU despite performing no mint CPI. Claim-funded fills similarly supply all four claim mint/vault pairs as writable although they do not mint/burn/transfer those tokens.

Consider a small rest-only instruction and a claim-only settlement variant after the heap fix, using readonly token accounts and a single validated supply/balance snapshot when no token CPI can occur. Check final liabilities against that snapshot after internal ledger mutations. Do not bypass backing checks because the route is cheaper.

Keep the public API simple by choosing the route in the SDK. Demonstrate worthwhile savings before accepting the maintenance/security surface of multiple entrypoints. Readonly token accounts alone do not make this market concurrent: every route still writes the shared Market.

### COST-06 — Medium: maker limit exceeds practical client packet capacity

Location: `packages/solana-client/src/transactions.ts::prepareTransaction` compiles v0 without lookup tables and rejects serialized transactions over 1,232 bytes.

Fixture sizes (one signer, one budget instruction, initialized participants, no separate recipients):

| Makers | Distinct-owner v0 bytes, no LUT | Shared-owner v0 bytes, no LUT |
| --- | ---: | ---: |
| 0 | 916 | — |
| 1 | 1,031 | — |
| 2 | 1,146 | 1,080 |
| 4 | 1,376 | 1,178 |
| 8 | 1,836 | 1,374 |

The profiler uses a synthetic frozen lookup table only for oversized messages; distinct-owner four/eight-maker transactions then fit at 511/599 bytes, but still exhaust heap. Production does not currently use this table. Extra recipients, initialization instructions, and a pinned CU-price instruction alter these sizes.

Add byte-aware planning before wallet approval and carefully managed/cached lookup tables if larger atomic matches are needed. LUTs reduce address bytes, not runtime account count or heap use. Do not fix this by silently splitting an atomic user order into different transactions or increasing `MAX_MAKERS`. [Solana transaction limits and atomicity](https://solana.com/docs/core/transactions)

### COST-07 — Medium architectural: shared market write lock and repeated quoting transactions

Both branches and all custody/position operations mutate a common Market. Distinct markets can execute independently, but YES and NO trading on one market cannot run in parallel while sharing this writable account. Readonly Config/Trader access is already helpful.

First pursue bounded cancel/replace or multi-post batches for market makers, reusing validated account data and existing vault credit. Batch only after fixing heap/packet limits. A single transaction can amortize signature overhead, but introduces all-or-nothing failure and larger resource demands.

Only split mutable Market state into branch/collateral risk shards after measuring real contention. Global market caps, backing, fees, sequence ordering, and shared collateral prevent a safe mechanical split. Avoid replacing per-market vaults with a global writable vault that serializes unrelated markets.

### COST-08 — Low/conditional: cold metadata, account layout, and deployment size

Market reserves two 512-byte URI fields in its 1,825-byte layout. Immutable metadata/hash and resolution evidence are candidates for cold accounts; hot accounting could use fixed-layout state or zero-copy. However, moving bytes into another account adds its own storage overhead and extra account handling. It does not automatically save rent. Hash-only storage changes data availability and client expectations.

The measured long-vs-short URI difference is only 237 CU for the tested placement. Fix heap, rent growth, and repeated CPIs first. Do not blindly convert small Wallet/Order structs to zero-copy; alignment, layout migration, borrow scopes around CPIs, and invariant preservation can outweigh gains. [Anchor zero-copy documentation](https://www.anchor-lang.com/docs/features/zero-copy)

Release settings already enable fat LTO, one codegen unit, and overflow checks. Preserve overflow checks. The SBF file size alone is not a deployed ProgramData rent quote: reserved deployment capacity matters. Size-oriented compiler experiments can be measured separately; do not trade checked arithmetic or Token-2022 policy for a smaller binary.

### COST-09 — Low today, important with priority fees: coarse compute requests

The SDK currently requests up to `200_000 * instruction_count + 100_000 * placement_legs`, capped at 1.4M. This does not distinguish whole/claim funding or participant count and cannot solve heap exhaustion. Strict fee-pinned transactions set CU price to zero.

After successful-path optimization, derive conservative budgets from a versioned workload matrix (funding mode, legs, initialization, extensions), with measured headroom. Refresh baselines whenever program/runtime changes. If priority fees are introduced, cap user spend explicitly and retain strict reviewed-message validation. Use simulation when needed; do not add repetitive serial simulations/RPCs to every input change. [Solana compute-budget estimation example](https://solana.com/developers/cookbook/transactions/optimize-compute)

## Review by instruction/function group

| Code paths reviewed | Assessment / optimization boundary |
| --- | --- |
| `initialize`, `configure`, `propose_admin`, `accept_admin`, `pause` | Cold paths; preserve role separation, fee bounds, and two-step authority changes. Not a hot-path optimization priority. |
| `create_market`, `lifecycle`, `resolution_hash`, `resolve` | Terms validation and domain-separated commitment/state checks matter more than micro-CU savings. Hash/URI storage is COST-08; resolution evidence cannot silently change semantics. |
| `initialize_asset`, `initialize_claim` | One-time vault/mint rent; separate token programs are intentional. Four claim mints preserve external token functionality, not removable “duplicate storage.” |
| `initialize_wallet` | Owner/market wallet plus durable owner/config nonce account; potential empty-wallet cleanup requires replay/exposure review. |
| `deposit`, `deposit_bounded`, `withdraw`, `withdraw_bounded` | Measured classic paths are relatively small. Actual spendable deltas and minimum receipt guards must remain for transfer-fee collateral. |
| `split`, `merge`, `redeem` and position snapshot/check helpers | Reduce repeated identity derivations, never backing/delta checks. Preserve total external claim-supply backing and exact INVALID redemption treatment. |
| `transfer_credit`, `claim_fees` | Internal credit movements avoid token CPI already. Preserve source authorization, asset ranges, liabilities, and treasury role. |
| `invalidate_nonce` | Cheap persistent replay/cancellation boundary. Do not reclaim/reset this state as a rent shortcut. |
| `cancel`, `release`, `reduce_exposure` | Existing cancellation correctly separates filled quantities from released reservations. Rent reclamation requires COST-02, not a simple close attribute. |
| `place`, participant parsing, `wallet`, `nonce`, `settle_asset` | Primary CPU/heap/rent/packet target; COST-01 through COST-07. Retain deduplication and shared-owner ledger semantics. |
| `read_claim`, `check_collateral`, `check_delta`, `solvent`, mint/burn helpers | Retain supply, custody, authority, independently expected deltas, and checked liability accumulation. Optimize repeated identity work only. |
| `token_policy::allowed_extension`, `validate_mint` | Fail-closed extension policy is deliberate. Do not skip dynamic validation or assume any Token-2022 mint is supported. Transfer hooks/confidential features are not generally accepted. |
| `protocol-core`: quote/fee math, limits/caps, lifecycle, collateral liability, fill and intent checks | Checked integer/fixed-point math is appropriate. Consolidating repeated product/division work may be possible, but preserve overflow rejection, rounding direction, fee carry, and all numeric domains. No float or unchecked-width substitutions. |
| State/account/event definitions and instruction dispatch | Layout migration and event/indexer compatibility must accompany storage changes. Avoid removing events to save CU without replacing canonical indexing. |

## Relevant open-source comparisons

These are architectural references, not claims of economic or security equivalence. Pinned source was inspected locally:

- **MetaDAO**, commit `1a8d0d7359ba6f869b84a60b1d709e85ad263ba0`: conditional-vault common validation, split, merge, redeem, and vault state. Stored mint/vault identity and post-CPI reload/invariant patterns support reducing duplicate derivations while keeping fresh checks. Its classic-SPL assumptions and payout semantics must not replace our Token-2022 collateral and rounding rules wholesale. [Conditional vault source](https://github.com/metaDAOproject/programs/tree/1a8d0d7359ba6f869b84a60b1d709e85ad263ba0/programs/conditional_vault/src)
- **Phoenix**, commit `5a34f7f901fd9e04057198d4fc7b7286f78b53f2`: FIFO state, market dispatch/loading, and new-order processing. Fixed-capacity in-account structures and free-funds/order batching avoid a new permanent account for every quote. Its preallocated books have substantial upfront rent; do not import this architecture blindly into sparse conditional markets. [Phoenix source](https://github.com/Ellipsis-Labs/phoenix-v1/tree/5a34f7f901fd9e04057198d4fc7b7286f78b53f2/src)
- **OpenBook v2**, commit `f3e17421e675b083b584867594bf3cf4f675d156`: OpenOrdersAccount, BookSide, place-order, cancel-all-and-place, close-open-orders, constraints, and event logging. Reusable order slots, aggregate deposits, AccountLoader, and guarded cleanup are relevant to rent/batching. Stack event encoding is an option only within our stack limits. Review licensing before copying implementations. [OpenBook source](https://github.com/openbook-dex/openbook-v2/tree/f3e17421e675b083b584867594bf3cf4f675d156/programs/openbook-v2/src)

## Validation and reproduction

Existing host suite: **25 tests passed**, including ten property tests configured for 10,000 cases each. Existing compiled-SBF custody/supply hardening test: **passed**. New diagnostic profile: **completed**, explicitly reporting the OOM workloads rather than treating them as successful trades. The two-distinct-maker failure was executed and its state rollback verified.

Run from the workspace with Cargo and Solana build tools on PATH:

```sh
AUDIT_BUILD_DIR=$(mktemp -d /tmp/probabl-sbf-audit.XXXXXX)
cargo build-sbf --manifest-path programs/conditional-stocks/Cargo.toml --sbf-out-dir "$AUDIT_BUILD_DIR" --offline -- --offline
cargo test --workspace --offline
BPF_OUT_DIR="$AUDIT_BUILD_DIR" RUST_LOG=error cargo test -p conditional-stocks --test cost_profile --test sbf_hardening --offline -- --ignored --nocapture --test-threads=1
```

No network or real keypair is needed for these fixtures. The profiler source is `programs/conditional-stocks/tests/cost_profile.rs`. It prints costs, sizes, mint counts, rent, classified failures, and the rollback result. It uses preloaded valid-shaped synthetic accounts rather than full lifecycle setup; it complements, not replaces, lifecycle and validator integration tests. Full frontend/backend/local-validator suites, every Token-2022 extension combination, fuzzing, production contention, and deployed-binary verification were not run in this audit.

## Recommended implementation order

1. Make supported multi-maker workloads reliable: bounded allocations, aggregated CPIs, compiled-SBF success/rollback regression coverage.
2. Remove repeated immutable identity work while preserving all independent backing guards; benchmark before/after.
3. Add accurate byte-aware planning and, where worthwhile, cached lookup tables and measured CU budgets.
4. Design reusable/closable order storage with explicit replay protection and a versioned migration. This is the largest ongoing SOL saving.
5. Add bounded market-maker cancel/replace/post batches. Consider hot/cold layout and lock sharding only if measurements justify them.

No numeric claim of “maximum optimization” is justified yet. Set reproducible CU/heap/packet/rent budgets in CI and require differential accounting tests and another security review for each settlement or storage change.
