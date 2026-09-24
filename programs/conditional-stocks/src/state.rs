use anchor_lang::prelude::*;
use protocol_core as rules;

/// Base (stock) legs per market: one per whitelisted issuer of the same asset.
/// Bounded by the 4 KiB SBF frame that deserializes Market and Wallet.
pub const MAX_BASES: usize = 3;
/// Collateral 0 is the deployment quote (USDC); collaterals 1..=MAX_BASES are base legs.
pub const COLLATERALS: usize = 1 + MAX_BASES;
/// Per collateral: underlying (3c), YES claim (3c + 1) and NO claim (3c + 2).
pub const ASSETS: usize = 3 * COLLATERALS;
pub const QUOTE: usize = 0;
pub const MAX_MAKERS: usize = 8;
/// Placements retained per branch so a resting order cannot race past an
/// opposite order its plan could not see (see `place`).
pub const RECENT: usize = 16;
pub const RECENT_SLOTS: usize = 2 * RECENT;
/// Accounts per touched base leg in `place`: pool, pool vault, mint, then
/// (claim mint, claim vault) for YES and NO.
pub const LEG_ACCOUNTS: usize = 7;

pub const fn underlying(collateral: usize) -> usize {
    3 * collateral
}
pub const fn claim(collateral: usize, branch: usize) -> usize {
    3 * collateral + 1 + branch
}
pub const fn collateral_of(asset: usize) -> usize {
    asset / 3
}
pub const fn is_claim(asset: usize) -> bool {
    !asset.is_multiple_of(3)
}
/// Exactly one listed base leg, as delivered by a sell order.
pub fn single_base(bases: u8) -> Option<usize> {
    (bases.count_ones() == 1 && (bases.trailing_zeros() as usize) < MAX_BASES)
        .then(|| bases.trailing_zeros() as usize + 1)
}
pub const NONCE_BOUND_SALT: [u8; 8] = *b"PRBLOv02";
pub const ADMIN_DELAY: i64 = 172_800;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct Roles {
    pub market_admin: Pubkey,
    pub guardian: Pubkey,
    pub resolution_admin: Pubkey,
}

impl Roles {
    pub fn validate(&self) -> Result<()> {
        for key in [self.market_admin, self.guardian, self.resolution_admin] {
            require_keys_neq!(key, Pubkey::default(), ProtocolError::InvalidAddress);
        }
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub seed_authority: Pubkey,
    pub admin: Pubkey,
    pub quote_mint: Pubkey,
    pub roles: Roles,
    pub paused: bool,
    pub maker_bps: u16,
    pub taker_bps: u16,
    pub pending_admin: Pubkey,
    pub admin_after: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct Terms {
    pub condition: [u8; 32],
    pub yes_index: u8,
    pub no_index: u8,
    pub rules_hash: [u8; 32],
    pub metadata_hash: [u8; 32],
    #[max_len(512)]
    pub metadata_uri: String,
    pub trading_open: i64,
    pub trading_cutoff: i64,
    /// Canonical share-unit decimals. Order quantities, step and max_quantity
    /// are share units; a base leg with d decimals converts at 10^(d - share_decimals).
    pub share_decimals: u8,
    pub tick: u128,
    pub step: u64,
    pub min_notional: u64,
    pub max_quantity: u64,
    pub max_order: u64,
    pub max_wallet: u64,
    pub max_market: u64,
}

impl Terms {
    pub fn caps(&self) -> rules::Caps {
        rules::Caps {
            tick: self.tick,
            step: self.step,
            min_notional: self.min_notional,
            max_quantity: self.max_quantity,
            max_order: self.max_order,
            max_wallet: self.max_wallet,
            max_market: self.max_market,
        }
    }
}

/// One whitelisted issuer token of the market's asset. Claims on a leg are
/// backed only by that issuer's token; legs never share collateral.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct BaseLeg {
    /// 10^(decimals - share_decimals): raw issuer units per share unit at a
    /// multiplier of one. Deliveries also divide by the live multiplier.
    pub scale: u64,
    /// Effective ScaledUiAmount multiplier (f64 bits, 1.0 if none) at listing.
    /// A live multiplier outside the 4/5..5/4 band of it halts the leg.
    pub multiplier: u64,
    pub active: bool,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub config: Pubkey,
    pub id: [u8; 32],
    pub terms: Terms,
    /// Listed base legs occupy collaterals 1..=bases.
    pub bases: u8,
    pub legs: [BaseLeg; MAX_BASES],
    /// The four per-asset ledgers are heap vectors of exactly ASSETS entries
    /// (see `Market::ledgers`), keeping every SBF frame that deserializes a
    /// Market below 4 KiB. Their length never changes after creation.
    #[max_len(ASSETS)]
    pub mints: Vec<Pubkey>,
    pub decimals: [u8; COLLATERALS],
    pub pool_bumps: [u8; COLLATERALS],
    pub vaults_initialized: u16,
    pub state: u8,
    pub sequence: [u64; 2],
    /// The last RECENT placements of each branch: branch b, sequence s at
    /// `b * RECENT + s % RECENT` (the sequence is implied: within the window
    /// each slot holds the latest placement mapping to it). Heap-sized like
    /// the ledgers. Kept compact: the market is rewritten by every placement.
    #[max_len(RECENT_SLOTS)]
    pub recent: Vec<Placement>,
    pub open_notional: u128,
    #[max_len(ASSETS)]
    pub credits: Vec<u128>,
    #[max_len(ASSETS)]
    pub escrow: Vec<u128>,
    pub backing: [u64; COLLATERALS],
    /// Indexed by claim asset; underlying slots stay zero.
    #[max_len(ASSETS)]
    pub fees: Vec<u64>,
    pub resolution_commitment: [u8; 32],
    pub payouts: [u8; 2],
    pub evidence: [u8; 32],
    #[max_len(512)]
    pub evidence_uri: String,
    pub resolved_at: i64,
    pub bump: u8,
}

impl Market {
    /// Size every per-asset ledger at creation. Handlers index these vectors by
    /// asset, and a deserialized market with any other length is rejected.
    pub fn ledgers(&mut self) {
        self.mints = vec![Pubkey::default(); ASSETS];
        self.credits = vec![0; ASSETS];
        self.escrow = vec![0; ASSETS];
        self.fees = vec![0; ASSETS];
        self.recent = vec![Placement::default(); RECENT_SLOTS];
    }
    pub fn well_formed(&self) -> bool {
        self.recent.len() == RECENT_SLOTS
            && self.mints.len() == ASSETS
            && self.credits.len() == ASSETS
            && self.escrow.len() == ASSETS
            && self.fees.len() == ASSETS
    }
    /// Exact size for the metadata and evidence URIs in use. Metadata is
    /// immutable; the evidence URI is allocated only when the market resolves,
    /// so trading never rewrites (or streams) reserved zero bytes.
    pub fn allocation_size(metadata_bytes: usize, evidence_bytes: usize) -> usize {
        8 + Self::INIT_SPACE - 1024 + metadata_bytes.min(512) + evidence_bytes.min(512)
    }
    pub fn liability(&self, asset: usize) -> Result<u128> {
        require!(asset < ASSETS, ProtocolError::InvalidAsset);
        let extra = if is_claim(asset) {
            self.fees[asset]
        } else {
            self.backing[collateral_of(asset)]
        };
        self.credits[asset]
            .checked_add(self.escrow[asset])
            .and_then(|n| n.checked_add(extra as u128))
            .ok_or_else(|| error!(ProtocolError::Arithmetic))
    }
    pub fn credit(&mut self, wallet: &mut Wallet, asset: usize, amount: u64) -> Result<()> {
        wallet.balances[asset] = add(wallet.balances[asset], amount)?;
        self.credits[asset] = self.credits[asset]
            .checked_add(amount as u128)
            .ok_or_else(|| error!(ProtocolError::Arithmetic))?;
        Ok(())
    }
    pub fn debit(&mut self, wallet: &mut Wallet, asset: usize, amount: u64) -> Result<()> {
        wallet.balances[asset] = sub(wallet.balances[asset], amount)?;
        self.credits[asset] = self.credits[asset]
            .checked_sub(amount as u128)
            .ok_or_else(|| error!(ProtocolError::Insolvent))?;
        Ok(())
    }
    /// Collateral 0 or a listed base leg.
    pub fn listed(&self, collateral: usize) -> bool {
        collateral == QUOTE || (1..=self.bases as usize).contains(&collateral)
    }
    pub fn collaterals(&self) -> usize {
        1 + self.bases as usize
    }
    /// Underlying custody plus both claim mints/vaults are initialized.
    pub fn ready(&self, collateral: usize) -> bool {
        self.listed(collateral)
            && self.vaults_initialized & (0b111 << (3 * collateral)) == 0b111 << (3 * collateral)
    }
    pub fn leg(&self, collateral: usize) -> Result<&BaseLeg> {
        require!(
            collateral >= 1 && self.listed(collateral),
            ProtocolError::InvalidAsset
        );
        Ok(&self.legs[collateral - 1])
    }
    /// New exposure (fills, underlying-funded placement, split) on a base leg.
    pub fn tradable(&self, collateral: usize) -> Result<&BaseLeg> {
        let leg = self.leg(collateral)?;
        require!(
            leg.active && self.ready(collateral),
            ProtocolError::LegHalted
        );
        Ok(leg)
    }
    /// Share units to the leg's raw issuer units at a live multiplier.
    pub fn raw(&self, collateral: usize, shares: u64, multiplier: u64, up: bool) -> Result<u64> {
        checked(rules::base_raw(
            shares,
            self.leg(collateral)?.scale,
            multiplier,
            up,
        ))
    }
    /// Live issuer state that still permits new exposure on a listed leg.
    pub fn exposable(&self, collateral: usize, paused: bool, multiplier: u64) -> Result<()> {
        let leg = self.tradable(collateral)?;
        require!(
            !paused && checked(rules::within_band(leg.multiplier, multiplier))?,
            ProtocolError::LegHalted
        );
        Ok(())
    }
    pub fn liabilities(&self) -> Result<[u128; COLLATERALS]> {
        let mut values = [0u128; COLLATERALS];
        for (collateral, value) in values.iter_mut().enumerate() {
            *value = self.liability(underlying(collateral))?;
        }
        Ok(values)
    }
    /// A market with every listed collateral ready and at least one active base leg.
    pub fn openable(&self) -> bool {
        self.ready(QUOTE)
            && (1..=self.bases as usize).all(|c| self.ready(c))
            && (1..=self.bases as usize).any(|c| self.legs[c - 1].active)
    }
}

#[account]
#[derive(InitSpace)]
pub struct Wallet {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub balances: [u64; ASSETS],
    pub open_notional: u128,
    pub bump: u8,
}

/// Owner-wide invalidation across every market in this protocol deployment.
/// Never closed or reset when another market wallet is initialized.
#[account]
#[derive(InitSpace)]
pub struct Trader {
    pub config: Pubkey,
    pub owner: Pubkey,
    pub minimum_nonce: u64,
    pub delegation_epoch: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct OrderTerms {
    pub recipient: Pubkey,
    pub salt: [u8; 32],
    pub quantity: u64,
    pub price: u128,
    pub expiry: i64,
    pub nonce: u64,
    pub max_fee_bps: u16,
    pub branch: u8,
    pub side: u8,
    pub funding: u8,
    pub tif: u8,
    /// Base-leg bitmask (bit i = collateral i + 1). A buy lists every issuer it
    /// accepts; a sell names exactly the one issuer token it delivers.
    pub bases: u8,
}

impl OrderTerms {
    /// The nonce is bound into the PDA seed so retired orders cannot be
    /// recreated with a newer nonce and different terms.
    pub fn bound_nonce(&self) -> Option<u64> {
        (self.salt[..8] == NONCE_BOUND_SALT)
            .then(|| u64::from_le_bytes(self.salt[8..16].try_into().expect("fixed salt slice")))
    }
    /// Buyers fund quote. Sellers fund exactly one base leg (validated at placement).
    pub fn collateral(&self) -> usize {
        if self.side == 0 {
            QUOTE
        } else {
            single_base(self.bases).unwrap_or(usize::MAX)
        }
    }
    pub fn asset(&self) -> usize {
        let collateral = self.collateral();
        if self.funding == 0 {
            underlying(collateral)
        } else {
            claim(collateral, self.branch as usize)
        }
    }
    /// Base legs this order can trade: a bid's accepted legs, an ask's single leg.
    pub fn accepts(&self, collateral: usize) -> bool {
        (1..=MAX_BASES).contains(&collateral) && self.bases & (1 << (collateral - 1)) != 0
    }
}

#[account]
#[derive(InitSpace)]
pub struct Order {
    pub market: Pubkey,
    pub owner: Pubkey,
    /// Zero for owner-signed orders; otherwise the immutable grant's signing key.
    pub delegate: Pubkey,
    pub terms: OrderTerms,
    pub remaining: u64,
    pub filled: u64, // Executed quantity only; cancellation never increases this counter.
    pub reserved: u64,
    pub open_notional: u64,
    pub sequence: u64,
    pub fee_carry: u16,
    pub status: u8, // 1 open, 2 filled, 3 cancelled; retirement requires permanent replay rejection.
    pub bump: u8,
}

/// A placement as retained for race checks: its limit price in ticks of the
/// market (prices are tick multiples) and its side, `rules::SIDE_NONE` when
/// the order did not rest.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace)]
pub struct Placement {
    pub ticks: u64,
    pub side: u8,
}
impl Default for Placement {
    fn default() -> Self {
        Self {
            ticks: 0,
            side: rules::SIDE_NONE,
        }
    }
}

/// Up to this many share units of one planned maker. A maker filled, cancelled
/// or invalidated since planning is skipped; a partially filled one is capped.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Leg {
    pub quantity: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Plan {
    pub deadline: i64,
    /// The branch sequence the plan observed: every planned maker is older.
    pub next_sequence: u64,
    /// Least total fill that makes the placement worthwhile (e.g. one step for
    /// immediate-or-cancel); fewer fillable makers fail it as stale.
    pub min_fill: u64,
    pub maker_bps: u16,
    pub taker_bps: u16,
    pub legs: Vec<Leg>,
}

pub fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b)
        .ok_or_else(|| error!(ProtocolError::Arithmetic))
}
pub fn sub(a: u64, b: u64) -> Result<u64> {
    a.checked_sub(b)
        .ok_or_else(|| error!(ProtocolError::InsufficientFunds))
}
pub fn checked<T>(value: rules::Result<T>) -> Result<T> {
    value.map_err(|err| match err {
        rules::Error::FractionalRedemption => error!(ProtocolError::FractionalRedemption),
        // A plan made against a book the chain has not reached, at other fee
        // rates, past its deadline, or racing an unseen crossing order: replan.
        rules::Error::StaleQuote => error!(ProtocolError::StalePlan),
        _ => error!(ProtocolError::InvalidTerms),
    })
}
pub fn asset_index(asset: u8) -> Result<usize> {
    require!((asset as usize) < ASSETS, ProtocolError::InvalidAsset);
    Ok(asset as usize)
}

#[event]
pub struct Change {
    pub market: Pubkey,
    pub account: Pubkey,
    pub kind: u8,
    pub amount: u64,
    pub asset: u8,
}

#[event]
pub struct Trade {
    pub market: Pubkey,
    pub taker: Pubkey,
    pub maker: Pubkey,
    pub branch: u8,
    /// Base leg (collateral index) whose claims the buyer received.
    pub base: u8,
    /// Share units.
    pub quantity: u64,
    /// Raw base-leg claim units delivered: floor(quantity * scale / live multiplier).
    pub base_amount: u64,
    pub price: u128,
    pub quote: u64,
    pub buyer_fee: u64,
    pub seller_fee: u64,
}

#[error_code]
pub enum ProtocolError {
    #[msg("Invalid or zero address")]
    InvalidAddress,
    #[msg("Invalid immutable terms or amount")]
    InvalidTerms,
    #[msg("Unauthorized signer")]
    Unauthorized,
    #[msg("Invalid lifecycle transition")]
    InvalidState,
    #[msg("Invalid asset index or mint")]
    InvalidAsset,
    #[msg("Arithmetic overflow")]
    Arithmetic,
    #[msg("Insufficient available balance")]
    InsufficientFunds,
    #[msg("Custody does not cover recorded liabilities")]
    Insolvent,
    #[msg("Account identity, owner, PDA or writability mismatch")]
    InvalidAccount,
    #[msg("Stale execution plan")]
    StalePlan,
    #[msg("Order is not open or not releasable")]
    InvalidOrder,
    #[msg("Current fees exceed the owner's cap")]
    FeeCap,
    #[msg("Admin transfer delay has not elapsed")]
    AdminDelay,
    #[msg("Resolution does not match the prepared commitment")]
    Commitment,
    #[msg("Token extension needs a separately reviewed issuer integration")]
    UnsupportedTokenExtension,
    #[msg("Actual spendable tokens received are below the signed minimum")]
    TransferSlippage,
    #[msg("Conditional backing does not cover outstanding claim supply")]
    ClaimBacking,
    #[msg("Unexpected claim mint supply or custody balance delta")]
    TokenDelta,
    #[msg("Redemption would discard a fractional raw unit; retain or combine the odd claim")]
    FractionalRedemption,
    #[msg("Invalid trading delegation, scope, recipient or limits")]
    InvalidDelegation,
    #[msg("Trading delegation was revoked, expired or globally invalidated")]
    DelegationInactive,
    #[msg("Delegated order exceeds its per-order or remaining allowance")]
    DelegateBudget,
    #[msg("Base leg is delisted, uninitialized, paused, frozen or past a split-sized multiplier change")]
    LegHalted,
    #[msg("Issuer token is paused")]
    IssuerPaused,
    #[msg("Issuer transfer hook is configured; hook execution is not supported")]
    TransferHookEnabled,
}
