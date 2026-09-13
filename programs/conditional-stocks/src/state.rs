use anchor_lang::prelude::*;
use protocol_core as rules;

pub const ASSETS: usize = 6;
pub const MAX_MAKERS: usize = 8;
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

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub config: Pubkey,
    pub id: [u8; 32],
    pub terms: Terms,
    pub mints: [Pubkey; ASSETS],
    pub decimals: [u8; 2],
    pub vaults_initialized: u8,
    pub state: u8,
    pub sequence: [u64; 2],
    pub open_notional: u128,
    pub credits: [u128; ASSETS],
    pub escrow: [u128; ASSETS],
    pub backing: [u64; 2],
    pub fees: [u64; 4],
    pub resolution_commitment: [u8; 32],
    pub payouts: [u8; 2],
    pub evidence: [u8; 32],
    #[max_len(512)]
    pub evidence_uri: String,
    pub resolved_at: i64,
    pub bump: u8,
}

impl Market {
    pub fn liability(&self, asset: usize) -> Result<u128> {
        let extra = if asset < 2 {
            self.backing[asset]
        } else {
            self.fees[asset - 2]
        };
        self.credits[asset]
            .checked_add(self.escrow[asset])
            .and_then(|n| n.checked_add(extra as u128))
            .ok_or(error!(ProtocolError::Arithmetic))
    }
    pub fn credit(&mut self, wallet: &mut Wallet, asset: usize, amount: u64) -> Result<()> {
        wallet.balances[asset] = add(wallet.balances[asset], amount)?;
        self.credits[asset] = self.credits[asset]
            .checked_add(amount as u128)
            .ok_or(error!(ProtocolError::Arithmetic))?;
        Ok(())
    }
    pub fn debit(&mut self, wallet: &mut Wallet, asset: usize, amount: u64) -> Result<()> {
        wallet.balances[asset] = sub(wallet.balances[asset], amount)?;
        self.credits[asset] = self.credits[asset]
            .checked_sub(amount as u128)
            .ok_or(error!(ProtocolError::Insolvent))?;
        Ok(())
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
}

impl OrderTerms {
    pub fn asset(&self) -> usize {
        let collateral = if self.side == 0 { 1 } else { 0 };
        if self.funding == 0 {
            collateral
        } else {
            2 + collateral * 2 + self.branch as usize
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct Order {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub terms: OrderTerms,
    pub remaining: u64,
    pub filled: u64, // Executed quantity only; cancellation never increases this counter.
    pub reserved: u64,
    pub open_notional: u64,
    pub sequence: u64,
    pub fee_carry: u16,
    pub status: u8, // 1 open, 2 filled, 3 cancelled; tombstones are never closed.
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Leg {
    pub quantity: u64,
    pub expected_remaining: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Plan {
    pub deadline: i64,
    pub next_sequence: u64,
    pub maker_bps: u16,
    pub taker_bps: u16,
    pub legs: Vec<Leg>,
}

pub fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b).ok_or(error!(ProtocolError::Arithmetic))
}
pub fn sub(a: u64, b: u64) -> Result<u64> {
    a.checked_sub(b)
        .ok_or(error!(ProtocolError::InsufficientFunds))
}
pub fn checked<T>(value: rules::Result<T>) -> Result<T> {
    value.map_err(|err| match err {
        rules::Error::FractionalRedemption => error!(ProtocolError::FractionalRedemption),
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
    pub quantity: u64,
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
}
