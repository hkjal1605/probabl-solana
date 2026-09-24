use crate::invariants::{self, ClaimSnapshot};
use crate::{
    pool::{self, AssetCredit, AssetPool},
    state::*,
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount};
use anchor_spl::token_interface::{
    self, Mint as InterfaceMint, TokenAccount as InterfaceTokenAccount, TokenInterface,
    TransferChecked,
};
use protocol_core as rules;

#[derive(Accounts)]
#[instruction(collateral: u8)]
pub struct InitializeClaims<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"market", market.config.as_ref(), &market.id], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    // Safe indexing in the constraints; the handler rejects unlisted collaterals.
    #[account(init, payer = payer,
        seeds = [b"claim", market.key().as_ref(), &[3u8.saturating_mul(collateral).saturating_add(1)]], bump,
        mint::decimals = market.decimals[usize::from(collateral).min(COLLATERALS - 1)], mint::authority = market)]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(init, payer = payer,
        seeds = [b"claim", market.key().as_ref(), &[3u8.saturating_mul(collateral).saturating_add(2)]], bump,
        mint::decimals = market.decimals[usize::from(collateral).min(COLLATERALS - 1)], mint::authority = market)]
    pub no_mint: Box<Account<'info, Mint>>,
    #[account(init, payer = payer,
        seeds = [b"vault", market.key().as_ref(), &[3u8.saturating_mul(collateral).saturating_add(1)]], bump,
        token::mint = yes_mint, token::authority = market)]
    pub yes_vault: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = payer,
        seeds = [b"vault", market.key().as_ref(), &[3u8.saturating_mul(collateral).saturating_add(2)]], bump,
        token::mint = no_mint, token::authority = market)]
    pub no_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Creates both outcome claim mints and vaults of one listed collateral.
pub fn initialize_claims(ctx: Context<InitializeClaims>, collateral: u8) -> Result<()> {
    let c = usize::from(collateral);
    let market = &mut ctx.accounts.market;
    require!(
        c < COLLATERALS && market.listed(c),
        ProtocolError::InvalidAsset
    );
    for (branch, mint) in [ctx.accounts.yes_mint.key(), ctx.accounts.no_mint.key()]
        .into_iter()
        .enumerate()
    {
        let asset = claim(c, branch);
        require_keys_eq!(
            market.mints[asset],
            Pubkey::default(),
            ProtocolError::InvalidState
        );
        market.mints[asset] = mint;
        market.vaults_initialized |= 1 << asset;
    }
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeWallet<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Receives no authority. Its exact public key identifies the credit owner.
    pub owner: UncheckedAccount<'info>,
    #[account(seeds = [b"market", market.config.as_ref(), &market.id], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(init, payer = payer, space = 8 + Wallet::INIT_SPACE,
        seeds = [b"wallet", market.key().as_ref(), owner.key().as_ref()], bump)]
    pub wallet: Account<'info, Wallet>,
    #[account(init_if_needed, payer = payer, space = 8 + Trader::INIT_SPACE,
        seeds = [b"trader", market.config.as_ref(), owner.key().as_ref()], bump)]
    pub trader: Account<'info, Trader>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_wallet(ctx: Context<InitializeWallet>) -> Result<()> {
    require_keys_neq!(
        ctx.accounts.owner.key(),
        Pubkey::default(),
        ProtocolError::InvalidAddress
    );
    let wallet = &mut ctx.accounts.wallet;
    wallet.market = ctx.accounts.market.key();
    wallet.owner = ctx.accounts.owner.key();
    wallet.bump = ctx.bumps.wallet;
    // Do not reset minimum_nonce: an existing trader may already have invalidated orders.
    ctx.accounts.trader.config = ctx.accounts.market.config;
    ctx.accounts.trader.owner = ctx.accounts.owner.key();
    ctx.accounts.trader.bump = ctx.bumps.trader;
    Ok(())
}

#[derive(Accounts)]
#[instruction(asset: u8)]
pub struct Deposit<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"market", market.config.as_ref(), &market.id], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, has_one = market, has_one = owner,
        seeds = [b"wallet", market.key().as_ref(), owner.key().as_ref()], bump = wallet.bump)]
    pub wallet: Box<Account<'info, Wallet>>,
    #[account(owner = token_program.key())]
    pub mint: Box<InterfaceAccount<'info, InterfaceMint>>,
    #[account(mut, token::mint = mint, token::authority = owner, token::token_program = token_program)]
    pub source: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,
    #[account(mut, seeds = [b"vault", market.key().as_ref(), &[asset]], bump,
        token::mint = mint, token::authority = market, token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn deposit(ctx: Context<Deposit>, asset: u8, amount: u64) -> Result<()> {
    // Legacy instruction preserves its exact-receipt semantics for existing clients.
    deposit_bounded(ctx, asset, amount, amount)
}

pub fn deposit_bounded(
    ctx: Context<Deposit>,
    asset: u8,
    amount: u64,
    minimum_credit: u64,
) -> Result<()> {
    crate::token_policy::validate_mint(&ctx.accounts.mint.to_account_info())?;
    let i = claim_index(&ctx.accounts.market, asset)?;
    require!(
        amount > 0 && minimum_credit > 0 && minimum_credit <= amount,
        ProtocolError::InvalidTerms
    );
    require_keys_eq!(
        ctx.accounts.mint.key(),
        ctx.accounts.market.mints[i],
        ProtocolError::InvalidAsset
    );
    require_keys_neq!(
        ctx.accounts.source.key(),
        ctx.accounts.vault.key(),
        ProtocolError::InvalidAccount
    );
    let before = ctx.accounts.vault.amount;
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.source.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;
    ctx.accounts.vault.reload()?;
    let received = sub(ctx.accounts.vault.amount, before)?;
    require!(received <= amount, ProtocolError::Insolvent);
    require!(received >= minimum_credit, ProtocolError::TransferSlippage);
    ctx.accounts
        .market
        .credit(&mut ctx.accounts.wallet, i, received)?;
    solvent(&ctx.accounts.market, i, ctx.accounts.vault.amount)?;
    emit!(Change {
        market: ctx.accounts.market.key(),
        account: ctx.accounts.owner.key(),
        kind: 4,
        amount: received,
        asset
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(asset: u8)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"market", market.config.as_ref(), &market.id], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, has_one = market, has_one = owner,
        seeds = [b"wallet", market.key().as_ref(), owner.key().as_ref()], bump = wallet.bump)]
    pub wallet: Box<Account<'info, Wallet>>,
    #[account(owner = token_program.key())]
    pub mint: Box<InterfaceAccount<'info, InterfaceMint>>,
    // Only the credit owner signs; they may choose an alternate destination for recovery.
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub destination: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,
    #[account(mut, seeds = [b"vault", market.key().as_ref(), &[asset]], bump,
        token::mint = mint, token::authority = market, token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn withdraw(ctx: Context<Withdraw>, asset: u8, amount: u64) -> Result<()> {
    withdraw_bounded(ctx, asset, amount, amount)
}

pub fn withdraw_bounded(
    ctx: Context<Withdraw>,
    asset: u8,
    amount: u64,
    minimum_received: u64,
) -> Result<()> {
    crate::token_policy::validate_mint(&ctx.accounts.mint.to_account_info())?;
    let i = claim_index(&ctx.accounts.market, asset)?;
    require!(
        amount > 0 && minimum_received > 0 && minimum_received <= amount,
        ProtocolError::InvalidTerms
    );
    require_keys_eq!(
        ctx.accounts.mint.key(),
        ctx.accounts.market.mints[i],
        ProtocolError::InvalidAsset
    );
    require_keys_neq!(
        ctx.accounts.destination.key(),
        ctx.accounts.vault.key(),
        ProtocolError::InvalidAccount
    );
    solvent(&ctx.accounts.market, i, ctx.accounts.vault.amount)?;
    let before_vault = ctx.accounts.vault.amount;
    let before_destination = ctx.accounts.destination.amount;
    ctx.accounts
        .market
        .debit(&mut ctx.accounts.wallet, i, amount)?;
    let market = &ctx.accounts.market;
    let seeds: &[&[u8]] = &[
        b"market",
        market.config.as_ref(),
        &market.id,
        &[market.bump],
    ];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                authority: market.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;
    ctx.accounts.vault.reload()?;
    ctx.accounts.destination.reload()?;
    require!(
        sub(before_vault, ctx.accounts.vault.amount)? == amount,
        ProtocolError::Insolvent
    );
    let received = sub(ctx.accounts.destination.amount, before_destination)?;
    require!(received <= amount, ProtocolError::Insolvent);
    require!(
        received >= minimum_received,
        ProtocolError::TransferSlippage
    );
    solvent(&ctx.accounts.market, i, ctx.accounts.vault.amount)?;
    emit!(Change {
        market: market.key(),
        account: ctx.accounts.owner.key(),
        kind: 5,
        amount,
        asset
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(collateral: u8)]
pub struct Positions<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"market", market.config.as_ref(), &market.id], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, has_one = market, has_one = owner,
        seeds = [b"wallet", market.key().as_ref(), owner.key().as_ref()], bump = wallet.bump)]
    pub wallet: Box<Account<'info, Wallet>>,
    #[account(mut)]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub no_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [b"vault", market.key().as_ref(), &[3u8.saturating_mul(collateral).saturating_add(1)]], bump,
        token::mint = yes_mint, token::authority = market)]
    pub yes_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [b"vault", market.key().as_ref(), &[3u8.saturating_mul(collateral).saturating_add(2)]], bump,
        token::mint = no_mint, token::authority = market)]
    pub no_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    // Read-only: position operations move credit/backing, not issuer tokens.
    // Safe constraint indexing; validate() rejects every unlisted collateral.
    #[account(seeds = [b"pool", market.config.as_ref(), market.mints[3 * usize::from(collateral).min(COLLATERALS - 1)].as_ref()],
        bump = pool.bump)]
    pub pool: Box<Account<'info, AssetPool>>,
    /// Created beforehand by `initialize_credit` (idempotent; the SDK prepends it).
    #[account(mut, seeds = [b"asset-credit", pool.key().as_ref(), owner.key().as_ref()], bump = credit.bump,
        constraint = credit.owner == owner.key() @ ProtocolError::Unauthorized,
        constraint = credit.pool == pool.key() @ ProtocolError::InvalidAccount)]
    pub credit: Box<Account<'info, AssetCredit>>,
    #[account(seeds = [b"pool-vault", pool.key().as_ref()], bump = pool.vault_bump,
        constraint = underlying_vault.mint == pool.mint @ ProtocolError::InvalidAsset,
        constraint = underlying_vault.owner == pool.key() @ ProtocolError::InvalidAccount)]
    pub underlying_vault: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,
    /// CHECK: The pool's issuer mint, read for its live pause/multiplier state on split.
    #[account(address = pool.mint @ ProtocolError::InvalidAsset,
        owner = pool.token_program @ ProtocolError::InvalidAccount)]
    pub underlying_mint: UncheckedAccount<'info>,
}

impl Positions<'_> {
    fn hydrate(&mut self, collateral: usize) -> Result<[u128; COLLATERALS]> {
        pool::empty_underlying(&self.market)?;
        require!(
            pool::empty_wallet(&self.wallet),
            ProtocolError::InvalidAccount
        );
        self.market.credit(
            &mut self.wallet,
            underlying(collateral),
            self.credit.available,
        )?;
        self.market.liabilities()
    }
    fn flush(&mut self, collateral: usize, before: [u128; COLLATERALS]) -> Result<()> {
        pool::conserved(&self.market, before)?;
        self.credit.available = self.wallet.balances[underlying(collateral)];
        self.market.debit(
            &mut self.wallet,
            underlying(collateral),
            self.credit.available,
        )?;
        pool::empty_underlying(&self.market)
    }
    fn snapshot(&self, collateral: usize) -> Result<[ClaimSnapshot; 2]> {
        let i = self.validate(collateral)?;
        pool::validate_pool(
            &self.pool.to_account_info(),
            &self.market,
            collateral,
            self.underlying_vault.amount,
        )?;
        let claims = [
            invariants::read_claim_with_validated_vault(
                &self.market,
                &self.market.key(),
                i,
                &self.yes_mint.to_account_info(),
                &self.yes_vault.to_account_info(),
            )?,
            invariants::read_claim_with_validated_vault(
                &self.market,
                &self.market.key(),
                i + 1,
                &self.no_mint.to_account_info(),
                &self.no_vault.to_account_info(),
            )?,
        ];
        invariants::check_collateral(
            &self.market,
            collateral,
            self.underlying_vault.amount,
            claims,
        )?;
        Ok(claims)
    }
    fn verify(
        &self,
        collateral: usize,
        before: [ClaimSnapshot; 2],
        amounts: [u64; 2],
        minting: bool,
    ) -> Result<()> {
        let after = [
            invariants::reload_claim(
                &self.yes_mint.to_account_info(),
                &self.yes_vault.to_account_info(),
            )?,
            invariants::reload_claim(
                &self.no_mint.to_account_info(),
                &self.no_vault.to_account_info(),
            )?,
        ];
        invariants::check_collateral(
            &self.market,
            collateral,
            self.underlying_vault.amount,
            after,
        )?;
        for i in 0..2 {
            invariants::check_delta(before[i], after[i], amounts[i], minting)?;
        }
        Ok(())
    }
    fn validate(&self, collateral: usize) -> Result<usize> {
        require!(
            collateral < COLLATERALS && self.market.ready(collateral),
            ProtocolError::InvalidAsset
        );
        let i = claim(collateral, 0);
        require_keys_eq!(
            self.yes_mint.key(),
            self.market.mints[i],
            ProtocolError::InvalidAsset
        );
        require_keys_eq!(
            self.no_mint.key(),
            self.market.mints[i + 1],
            ProtocolError::InvalidAsset
        );
        Ok(i)
    }
    /// Minting new claims is new exposure: a base leg must be listed, active,
    /// unpaused, unfrozen and inside its multiplier band. Merge/redeem never are.
    fn exposable(&self, collateral: usize) -> Result<()> {
        if collateral == QUOTE {
            return Ok(());
        }
        let state = crate::token_policy::inspect(
            &self.underlying_mint.to_account_info(),
            self.pool.admitted,
            Clock::get()?.unix_timestamp,
        )?;
        require!(!self.underlying_vault.is_frozen(), ProtocolError::LegHalted);
        self.market
            .exposable(collateral, state.paused, state.multiplier)
    }
    fn mint(&self, amount: u64) -> Result<()> {
        mint_claim(
            &self.market,
            self.market.to_account_info(),
            self.yes_mint.to_account_info(),
            self.yes_vault.to_account_info(),
            amount,
        )?;
        mint_claim(
            &self.market,
            self.market.to_account_info(),
            self.no_mint.to_account_info(),
            self.no_vault.to_account_info(),
            amount,
        )
    }
    fn burn(&self, yes: u64, no: u64) -> Result<()> {
        burn_claim(
            &self.market,
            self.market.to_account_info(),
            self.yes_mint.to_account_info(),
            self.yes_vault.to_account_info(),
            yes,
        )?;
        burn_claim(
            &self.market,
            self.market.to_account_info(),
            self.no_mint.to_account_info(),
            self.no_vault.to_account_info(),
            no,
        )
    }
}

pub fn split(ctx: Context<Positions>, collateral: u8, amount: u64) -> Result<()> {
    let c = usize::from(collateral);
    let i = ctx.accounts.validate(c)?;
    require!(amount > 0, ProtocolError::InvalidTerms);
    ctx.accounts.exposable(c)?;
    let conserved = ctx.accounts.hydrate(c)?;
    let before = ctx.accounts.snapshot(c)?;
    ctx.accounts
        .market
        .debit(&mut ctx.accounts.wallet, underlying(c), amount)?;
    ctx.accounts.market.backing[c] = add(ctx.accounts.market.backing[c], amount)?;
    ctx.accounts.mint(amount)?;
    ctx.accounts
        .market
        .credit(&mut ctx.accounts.wallet, i, amount)?;
    ctx.accounts
        .market
        .credit(&mut ctx.accounts.wallet, i + 1, amount)?;
    ctx.accounts.verify(c, before, [amount, amount], true)?;
    ctx.accounts.flush(c, conserved)?;
    emit!(Change {
        market: ctx.accounts.market.key(),
        account: ctx.accounts.owner.key(),
        kind: 6,
        amount,
        asset: collateral
    });
    Ok(())
}

pub fn merge(ctx: Context<Positions>, collateral: u8, amount: u64) -> Result<()> {
    let c = usize::from(collateral);
    let i = ctx.accounts.validate(c)?;
    require!(amount > 0, ProtocolError::InvalidTerms);
    let conserved = ctx.accounts.hydrate(c)?;
    let before = ctx.accounts.snapshot(c)?;
    ctx.accounts
        .market
        .debit(&mut ctx.accounts.wallet, i, amount)?;
    ctx.accounts
        .market
        .debit(&mut ctx.accounts.wallet, i + 1, amount)?;
    ctx.accounts.burn(amount, amount)?;
    ctx.accounts.market.backing[c] = sub(ctx.accounts.market.backing[c], amount)?;
    ctx.accounts
        .market
        .credit(&mut ctx.accounts.wallet, underlying(c), amount)?;
    ctx.accounts.verify(c, before, [amount, amount], false)?;
    ctx.accounts.flush(c, conserved)?;
    emit!(Change {
        market: ctx.accounts.market.key(),
        account: ctx.accounts.owner.key(),
        kind: 7,
        amount,
        asset: collateral
    });
    Ok(())
}

pub fn redeem(
    ctx: Context<Positions>,
    collateral: u8,
    yes_amount: u64,
    no_amount: u64,
) -> Result<()> {
    let c = usize::from(collateral);
    let i = ctx.accounts.validate(c)?;
    require!(yes_amount > 0 || no_amount > 0, ProtocolError::InvalidTerms);
    require!(
        [rules::REDEEMABLE, rules::ARCHIVED].contains(&ctx.accounts.market.state),
        ProtocolError::InvalidState
    );
    let amount = checked(rules::redemption(
        yes_amount,
        no_amount,
        ctx.accounts.market.payouts[0],
        ctx.accounts.market.payouts[1],
    ))?;
    let conserved = ctx.accounts.hydrate(c)?;
    let before = ctx.accounts.snapshot(c)?;
    ctx.accounts
        .market
        .debit(&mut ctx.accounts.wallet, i, yes_amount)?;
    ctx.accounts
        .market
        .debit(&mut ctx.accounts.wallet, i + 1, no_amount)?;
    ctx.accounts.burn(yes_amount, no_amount)?;
    ctx.accounts.market.backing[c] = sub(ctx.accounts.market.backing[c], amount)?;
    ctx.accounts
        .market
        .credit(&mut ctx.accounts.wallet, underlying(c), amount)?;
    ctx.accounts
        .verify(c, before, [yes_amount, no_amount], false)?;
    ctx.accounts.flush(c, conserved)?;
    emit!(Change {
        market: ctx.accounts.market.key(),
        account: ctx.accounts.owner.key(),
        kind: 8,
        amount,
        asset: collateral
    });
    Ok(())
}

/// A claim asset of a listed collateral.
pub fn claim_index(market: &Market, asset: u8) -> Result<usize> {
    let i = asset_index(asset)?;
    require!(
        is_claim(i) && market.listed(collateral_of(i)),
        ProtocolError::InvalidAsset
    );
    Ok(i)
}

pub fn solvent(market: &Market, asset: usize, balance: u64) -> Result<()> {
    require!(
        balance as u128 >= market.liability(asset)?,
        ProtocolError::Insolvent
    );
    Ok(())
}

pub fn mint_claim<'info>(
    market: &Market,
    authority: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    vault: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let seeds: &[&[u8]] = &[
        b"market",
        market.config.as_ref(),
        &market.id,
        &[market.bump],
    ];
    token::mint_to(
        CpiContext::new_with_signer(
            token::ID,
            MintTo {
                mint,
                to: vault,
                authority,
            },
            &[seeds],
        ),
        amount,
    )
}

pub fn burn_claim<'info>(
    market: &Market,
    authority: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    vault: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let seeds: &[&[u8]] = &[
        b"market",
        market.config.as_ref(),
        &market.id,
        &[market.bump],
    ];
    token::burn(
        CpiContext::new_with_signer(
            token::ID,
            Burn {
                mint,
                from: vault,
                authority,
            },
            &[seeds],
        ),
        amount,
    )
}

#[derive(Accounts)]
pub struct TransferCredit<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [b"market", market.config.as_ref(), &market.id], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, has_one = market, has_one = owner,
        seeds = [b"wallet", market.key().as_ref(), owner.key().as_ref()], bump = source.bump)]
    pub source: Account<'info, Wallet>,
    #[account(mut, has_one = market,
        seeds = [b"wallet", market.key().as_ref(), destination.owner.as_ref()], bump = destination.bump,
        constraint = destination.key() != source.key() @ ProtocolError::InvalidAccount)]
    pub destination: Account<'info, Wallet>,
}

pub fn transfer_credit(ctx: Context<TransferCredit>, asset: u8, amount: u64) -> Result<()> {
    let i = claim_index(&ctx.accounts.market, asset)?;
    require!(amount > 0, ProtocolError::InvalidTerms);
    ctx.accounts.source.balances[i] = sub(ctx.accounts.source.balances[i], amount)?;
    ctx.accounts.destination.balances[i] = add(ctx.accounts.destination.balances[i], amount)?;
    emit!(Change {
        market: ctx.accounts.market.key(),
        account: ctx.accounts.owner.key(),
        kind: 9,
        amount,
        asset
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimFees<'info> {
    pub admin: Signer<'info>,
    #[account(has_one = admin, seeds = [b"config", config.seed_authority.as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, has_one = config, seeds = [b"market", config.key().as_ref(), &market.id], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, has_one = market,
        seeds = [b"wallet", market.key().as_ref(), destination.owner.as_ref()], bump = destination.bump)]
    pub destination: Account<'info, Wallet>,
}

pub fn claim_fees(ctx: Context<ClaimFees>, asset: u8, amount: u64) -> Result<()> {
    let i = claim_index(&ctx.accounts.market, asset)?;
    require!(amount > 0, ProtocolError::InvalidAsset);
    ctx.accounts.market.fees[i] = sub(ctx.accounts.market.fees[i], amount)?;
    ctx.accounts
        .market
        .credit(&mut ctx.accounts.destination, i, amount)?;
    emit!(Change {
        market: ctx.accounts.market.key(),
        account: ctx.accounts.destination.owner,
        kind: 10,
        amount,
        asset
    });
    Ok(())
}
