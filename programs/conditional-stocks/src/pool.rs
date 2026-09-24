//! Protocol-wide underlying custody. A pool's liability includes every user's
//! available credit AND collateral reserved/backing claims in every market.
//! Trading only reallocates that liability; only deposits/withdrawals change it.
use crate::{state::*, token_policy};
use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{
    extension::StateWithExtensions,
    state::{Account as RawTokenAccount, AccountState},
};
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

#[account]
#[derive(InitSpace)]
pub struct AssetPool {
    pub config: Pubkey,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub liability: u64,
    pub decimals: u8,
    pub bump: u8,
    /// Issuer-control categories the market administrator admitted for this mint.
    pub admitted: u16,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct AssetCredit {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub available: u64,
    pub bump: u8,
}

#[event]
pub struct PoolChange {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    /// 0 deposit (net received), 1 withdrawal (gross debited), 2 pool listed
    /// (amount = admitted issuer-control categories).
    pub kind: u8,
}

pub fn pool_address(config: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"pool", config.as_ref(), mint.as_ref()], &crate::ID).0
}
pub fn pool_vault(pool: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"pool-vault", pool.as_ref()], &crate::ID).0
}
pub fn underlying_address(market: &Market, collateral: usize) -> Pubkey {
    pool_vault(&pool_address(
        &market.config,
        &market.mints[underlying(collateral)],
    ))
}
/// Cheap canonical pool address for a listed collateral, from its recorded bump.
pub fn market_pool(market: &Market, collateral: usize) -> Result<Pubkey> {
    require!(market.listed(collateral), ProtocolError::InvalidAsset);
    Pubkey::create_program_address(
        &[
            b"pool",
            market.config.as_ref(),
            market.mints[underlying(collateral)].as_ref(),
            &[market.pool_bumps[collateral]],
        ],
        &crate::ID,
    )
    .map_err(|_| error!(ProtocolError::InvalidAccount))
}

#[derive(Accounts)]
pub struct InitializePool<'info> {
    /// Admission of issuer controls is a listing decision.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"config", config.seed_authority.as_ref()], bump = config.bump,
        constraint = config.roles.market_admin == payer.key() @ ProtocolError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(owner = token_program.key())]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = payer, space = 8 + AssetPool::INIT_SPACE,
        seeds = [b"pool", config.key().as_ref(), mint.key().as_ref()], bump)]
    pub pool: Account<'info, AssetPool>,
    #[account(init, payer = payer, seeds = [b"pool-vault", pool.key().as_ref()], bump,
        token::mint = mint, token::authority = pool, token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
pub fn initialize_pool(ctx: Context<InitializePool>, admitted: u16) -> Result<()> {
    // Admit exactly what the mint uses: an unused grant would silently widen
    // what a later issuer reconfiguration could introduce.
    let state = token_policy::validate_admitted(&ctx.accounts.mint.to_account_info(), admitted)?;
    require!(
        state.controls == admitted,
        ProtocolError::UnsupportedTokenExtension
    );
    ctx.accounts.pool.set_inner(AssetPool {
        config: ctx.accounts.config.key(),
        mint: ctx.accounts.mint.key(),
        token_program: ctx.accounts.token_program.key(),
        liability: 0,
        decimals: ctx.accounts.mint.decimals,
        bump: ctx.bumps.pool,
        admitted,
        vault_bump: ctx.bumps.vault,
    });
    emit!(PoolChange {
        pool: ctx.accounts.pool.key(),
        owner: ctx.accounts.payer.key(),
        amount: admitted as u64,
        kind: 2
    });
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeCredit<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Only identifies ownership; initialization grants no spending authority.
    pub owner: UncheckedAccount<'info>,
    #[account(seeds = [b"pool", pool.config.as_ref(), pool.mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, AssetPool>,
    #[account(init_if_needed, payer = payer, space = 8 + AssetCredit::INIT_SPACE,
        seeds = [b"asset-credit", pool.key().as_ref(), owner.key().as_ref()], bump)]
    pub credit: Account<'info, AssetCredit>,
    pub system_program: Program<'info, System>,
}
pub fn initialize_credit(ctx: Context<InitializeCredit>) -> Result<()> {
    require_keys_neq!(
        ctx.accounts.owner.key(),
        Pubkey::default(),
        ProtocolError::InvalidAddress
    );
    let credit = &mut ctx.accounts.credit;
    if credit.owner == Pubkey::default() {
        credit.pool = ctx.accounts.pool.key();
        credit.owner = ctx.accounts.owner.key();
        credit.bump = ctx.bumps.credit;
    } else {
        require_keys_eq!(
            credit.owner,
            ctx.accounts.owner.key(),
            ProtocolError::InvalidAccount
        );
        require_keys_eq!(
            credit.pool,
            ctx.accounts.pool.key(),
            ProtocolError::InvalidAccount
        );
        require!(
            credit.bump == ctx.bumps.credit,
            ProtocolError::InvalidAccount
        );
    }
    // Never reset an existing balance. Credit accounts are never closed.
    Ok(())
}

#[derive(Accounts)]
pub struct PoolTransfer<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, has_one = mint, has_one = token_program,
        seeds = [b"pool", pool.config.as_ref(), mint.key().as_ref()], bump = pool.bump)]
    pub pool: Account<'info, AssetPool>,
    #[account(init_if_needed, payer = owner, space = 8 + AssetCredit::INIT_SPACE,
        seeds = [b"asset-credit", pool.key().as_ref(), owner.key().as_ref()], bump)]
    pub credit: Account<'info, AssetCredit>,
    #[account(owner = token_program.key())]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [b"pool-vault", pool.key().as_ref()], bump = pool.vault_bump,
        token::mint = mint, token::authority = pool, token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    // Deposits require owner authority in the handler; withdrawals may go to an
    // owner-selected recipient, but never to the source vault itself.
    #[account(mut, token::mint = mint, token::token_program = token_program,
        constraint = external.key() != vault.key() @ ProtocolError::InvalidAccount)]
    pub external: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn deposit_pool(ctx: Context<PoolTransfer>, amount: u64, minimum_credit: u64) -> Result<()> {
    transfer(ctx, amount, minimum_credit, true)
}
pub fn withdraw_pool(ctx: Context<PoolTransfer>, amount: u64, minimum_received: u64) -> Result<()> {
    transfer(ctx, amount, minimum_received, false)
}
fn transfer(ctx: Context<PoolTransfer>, amount: u64, minimum: u64, deposit: bool) -> Result<()> {
    require!(
        amount > 0 && minimum > 0 && minimum <= amount,
        ProtocolError::InvalidTerms
    );
    token_policy::validate_admitted(
        &ctx.accounts.mint.to_account_info(),
        ctx.accounts.pool.admitted,
    )?
    .transferable()?;
    if ctx.accounts.credit.owner == Pubkey::default() {
        require!(
            deposit && ctx.accounts.credit.available == 0,
            ProtocolError::InsufficientFunds
        );
        ctx.accounts.credit.pool = ctx.accounts.pool.key();
        ctx.accounts.credit.owner = ctx.accounts.owner.key();
        ctx.accounts.credit.bump = ctx.bumps.credit;
    }
    require_keys_eq!(
        ctx.accounts.credit.owner,
        ctx.accounts.owner.key(),
        ProtocolError::Unauthorized
    );
    require_keys_eq!(
        ctx.accounts.credit.pool,
        ctx.accounts.pool.key(),
        ProtocolError::InvalidAccount
    );
    require!(
        ctx.accounts.credit.bump == ctx.bumps.credit,
        ProtocolError::InvalidAccount
    );
    require!(
        ctx.accounts.mint.decimals == ctx.accounts.pool.decimals,
        ProtocolError::InvalidAsset
    );
    let before = ctx.accounts.vault.amount;
    require!(
        before >= ctx.accounts.pool.liability,
        ProtocolError::Insolvent
    );
    let external_before = ctx.accounts.external.amount;
    if deposit {
        require_keys_eq!(
            ctx.accounts.external.owner,
            ctx.accounts.owner.key(),
            ProtocolError::Unauthorized
        );
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.external.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.pool.decimals,
        )?;
    } else {
        ctx.accounts.credit.available = sub(ctx.accounts.credit.available, amount)?;
        ctx.accounts.pool.liability = sub(ctx.accounts.pool.liability, amount)?;
        let pool = &ctx.accounts.pool;
        let seeds: &[&[u8]] = &[
            b"pool",
            pool.config.as_ref(),
            pool.mint.as_ref(),
            &[pool.bump],
        ];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.external.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    authority: pool.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            pool.decimals,
        )?;
    }
    ctx.accounts.vault.reload()?;
    ctx.accounts.external.reload()?;
    let received = if deposit {
        require!(
            sub(external_before, ctx.accounts.external.amount)? == amount,
            ProtocolError::TokenDelta
        );
        sub(ctx.accounts.vault.amount, before)?
    } else {
        require!(
            sub(before, ctx.accounts.vault.amount)? == amount,
            ProtocolError::TokenDelta
        );
        sub(ctx.accounts.external.amount, external_before)?
    };
    require!(
        received <= amount && received >= minimum,
        ProtocolError::TransferSlippage
    );
    if deposit {
        ctx.accounts.credit.available = add(ctx.accounts.credit.available, received)?;
        ctx.accounts.pool.liability = add(ctx.accounts.pool.liability, received)?;
    }
    require!(
        ctx.accounts.vault.amount >= ctx.accounts.pool.liability,
        ProtocolError::Insolvent
    );
    emit!(PoolChange {
        pool: ctx.accounts.pool.key(),
        owner: ctx.accounts.owner.key(),
        amount: if deposit { received } else { amount },
        kind: u8::from(!deposit)
    });
    Ok(())
}

/// Pool accounts are readonly during settlement: no token transfers and no
/// change to global liabilities. Separate users/markets do not lock one global
/// writable ledger. Deposits/withdrawals still lock the pool and token vault.
pub fn validate_pool(
    info: &AccountInfo,
    market: &Market,
    collateral: usize,
    balance: u64,
) -> Result<AssetPool> {
    require_keys_eq!(*info.owner, crate::ID, ProtocolError::InvalidAccount);
    require!(market.listed(collateral), ProtocolError::InvalidAsset);
    let pool = AssetPool::try_deserialize(&mut info.try_borrow_data()?.as_ref())?;
    require_keys_eq!(pool.config, market.config, ProtocolError::InvalidAccount);
    require_keys_eq!(
        pool.mint,
        market.mints[underlying(collateral)],
        ProtocolError::InvalidAsset
    );
    let address = Pubkey::create_program_address(
        &[
            b"pool",
            pool.config.as_ref(),
            pool.mint.as_ref(),
            &[pool.bump],
        ],
        &crate::ID,
    )
    .map_err(|_| error!(ProtocolError::InvalidAccount))?;
    require_keys_eq!(*info.key, address, ProtocolError::InvalidAccount);
    require!(
        balance >= pool.liability
            && pool.liability as u128 >= market.liability(underlying(collateral))?,
        ProtocolError::Insolvent
    );
    Ok(pool)
}

/// Untyped base-leg custody for exposure paths: canonical pool, its canonical
/// vault (unfrozen, exact mint/authority) and the issuer mint's live state.
/// Returns (vault balance, live multiplier) after proving pool and market solvency.
pub fn validate_leg(
    market: &Market,
    collateral: usize,
    pool_info: &AccountInfo,
    vault_info: &AccountInfo,
    mint_info: &AccountInfo,
    now: i64,
) -> Result<(u64, u64)> {
    market.tradable(collateral)?;
    require_keys_eq!(
        *pool_info.key,
        market_pool(market, collateral)?,
        ProtocolError::InvalidAccount
    );
    require_keys_eq!(*pool_info.owner, crate::ID, ProtocolError::InvalidAccount);
    let pool = AssetPool::try_deserialize(&mut pool_info.try_borrow_data()?.as_ref())?;
    let vault_key = Pubkey::create_program_address(
        &[b"pool-vault", pool_info.key.as_ref(), &[pool.vault_bump]],
        &crate::ID,
    )
    .map_err(|_| error!(ProtocolError::InvalidAccount))?;
    require_keys_eq!(*vault_info.key, vault_key, ProtocolError::InvalidAccount);
    require_keys_eq!(
        *vault_info.owner,
        pool.token_program,
        ProtocolError::InvalidAccount
    );
    require_keys_eq!(*mint_info.key, pool.mint, ProtocolError::InvalidAsset);
    require_keys_eq!(
        *mint_info.owner,
        pool.token_program,
        ProtocolError::InvalidAccount
    );
    let balance = {
        let data = vault_info.try_borrow_data()?;
        let vault = StateWithExtensions::<RawTokenAccount>::unpack(&data)?.base;
        require_keys_eq!(vault.mint, pool.mint, ProtocolError::InvalidAsset);
        require_keys_eq!(vault.owner, *pool_info.key, ProtocolError::InvalidAccount);
        require!(
            vault.state == AccountState::Initialized,
            ProtocolError::LegHalted
        );
        vault.amount
    };
    let state = token_policy::inspect(mint_info, pool.admitted, now)?;
    market.exposable(collateral, state.paused, state.multiplier)?;
    // The canonical address binds (config, market mint); the stored identity must agree.
    require!(
        pool.config == market.config && pool.mint == market.mints[underlying(collateral)],
        ProtocolError::InvalidAccount
    );
    require!(
        balance >= pool.liability
            && pool.liability as u128 >= market.liability(underlying(collateral))?,
        ProtocolError::Insolvent
    );
    Ok((balance, state.multiplier))
}

/// Only the matching engine's validated participants may be hydrated. These
/// credits are temporarily represented in the existing exact-unit accounting;
/// they MUST be flushed to AssetCredit before successful instruction return.
pub struct CreditFrame {
    pub credit: AssetCredit,
    pub asset: usize,
}
impl CreditFrame {
    /// Any listed collateral of the market.
    pub fn load(info: &AccountInfo, market: &Market) -> Result<Self> {
        let mut pools = Vec::with_capacity(market.collaterals());
        for collateral in 0..market.collaterals() {
            pools.push((market_pool(market, collateral)?, collateral));
        }
        Self::load_for_pools(info, &pools)
    }
    /// `pools` pairs each admissible pool with its collateral index.
    pub fn load_for_pools(info: &AccountInfo, pools: &[(Pubkey, usize)]) -> Result<Self> {
        require!(info.is_writable, ProtocolError::InvalidAccount);
        require_keys_eq!(*info.owner, crate::ID, ProtocolError::InvalidAccount);
        let credit = AssetCredit::try_deserialize(&mut info.try_borrow_data()?.as_ref())?;
        let collateral = pools
            .iter()
            .find(|(pool, _)| *pool == credit.pool)
            .map(|(_, collateral)| *collateral)
            .ok_or_else(|| error!(ProtocolError::InvalidAccount))?;
        let asset = underlying(collateral);
        let address = Pubkey::create_program_address(
            &[
                b"asset-credit",
                credit.pool.as_ref(),
                credit.owner.as_ref(),
                &[credit.bump],
            ],
            &crate::ID,
        )
        .map_err(|_| error!(ProtocolError::InvalidAccount))?;
        require_keys_eq!(*info.key, address, ProtocolError::InvalidAccount);
        Ok(Self { credit, asset })
    }
    pub fn hydrate(&self, market: &mut Market, wallet: &mut Wallet) -> Result<()> {
        require_keys_eq!(
            self.credit.owner,
            wallet.owner,
            ProtocolError::InvalidAccount
        );
        require!(
            wallet.balances[self.asset] == 0,
            ProtocolError::InvalidAccount
        );
        market.credit(wallet, self.asset, self.credit.available)
    }
    pub fn flush(
        &mut self,
        info: &AccountInfo,
        market: &mut Market,
        wallet: &mut Wallet,
    ) -> Result<()> {
        self.credit.available = wallet.balances[self.asset];
        market.debit(wallet, self.asset, self.credit.available)?;
        self.credit
            .try_serialize(&mut info.try_borrow_mut_data()?.as_mut())
    }
}

pub fn empty_underlying(market: &Market) -> Result<()> {
    require!(
        (0..COLLATERALS).all(|c| market.credits[underlying(c)] == 0),
        ProtocolError::Insolvent
    );
    Ok(())
}

/// Wallet images never persist underlying credit; it lives in AssetCredit.
pub fn empty_wallet(wallet: &Wallet) -> bool {
    (0..COLLATERALS).all(|c| wallet.balances[underlying(c)] == 0)
}

/// Independently proves no collateral was created/lost while the backing,
/// reservation and available-credit ledgers were rearranged, for EACH mint.
pub fn conserved(market: &Market, before: [u128; COLLATERALS]) -> Result<()> {
    require!(market.liabilities()? == before, ProtocolError::Insolvent);
    Ok(())
}

/// `asset` is the underlying asset index the frame must fund.
pub fn hydrate_one(
    info: &AccountInfo,
    market: &mut Market,
    wallet: &mut Wallet,
    asset: usize,
) -> Result<(CreditFrame, [u128; COLLATERALS])> {
    empty_underlying(market)?;
    let collateral = collateral_of(asset);
    let frame =
        CreditFrame::load_for_pools(info, &[(market_pool(market, collateral)?, collateral)])?;
    require!(frame.asset == asset, ProtocolError::InvalidAsset);
    frame.hydrate(market, wallet)?;
    Ok((frame, market.liabilities()?))
}

pub fn flush_one(
    mut frame: CreditFrame,
    before: [u128; COLLATERALS],
    info: &AccountInfo,
    market: &mut Market,
    wallet: &mut Wallet,
) -> Result<()> {
    conserved(market, before)?;
    frame.flush(info, market, wallet)?;
    empty_underlying(market)
}
