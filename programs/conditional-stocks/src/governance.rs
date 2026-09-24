use crate::pool::AssetPool;
use crate::{state::*, token_policy};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use protocol_core as rules;
use solana_sha256_hasher::hashv;

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [b"config", admin.key().as_ref()], bump)]
    pub config: Account<'info, Config>,
    pub quote_mint: InterfaceAccount<'info, Mint>,
    pub system_program: Program<'info, System>,
}

pub fn initialize(ctx: Context<Initialize>, roles: Roles) -> Result<()> {
    crate::token_policy::validate_mint(&ctx.accounts.quote_mint.to_account_info())?;
    roles.validate()?;
    let config = &mut ctx.accounts.config;
    config.seed_authority = ctx.accounts.admin.key();
    config.admin = ctx.accounts.admin.key();
    config.quote_mint = ctx.accounts.quote_mint.key();
    config.roles = roles;
    config.bump = ctx.bumps.config;
    Ok(())
}

#[derive(Accounts)]
pub struct Configure<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config", config.seed_authority.as_ref()], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

pub fn configure(
    ctx: Context<Configure>,
    roles: Roles,
    maker_bps: u16,
    taker_bps: u16,
) -> Result<()> {
    roles.validate()?;
    require!(
        maker_bps <= rules::MAX_FEE_BPS && taker_bps <= rules::MAX_FEE_BPS,
        ProtocolError::FeeCap
    );
    let config = &mut ctx.accounts.config;
    config.roles = roles;
    config.maker_bps = maker_bps;
    config.taker_bps = taker_bps;
    Ok(())
}

pub fn propose_admin(ctx: Context<Configure>, successor: Pubkey) -> Result<()> {
    // A zero successor explicitly cancels a pending transfer.
    require_keys_neq!(
        successor,
        ctx.accounts.config.admin,
        ProtocolError::InvalidAddress
    );
    ctx.accounts.config.pending_admin = successor;
    ctx.accounts.config.admin_after = Clock::get()?
        .unix_timestamp
        .checked_add(ADMIN_DELAY)
        .ok_or_else(|| error!(ProtocolError::Arithmetic))?;
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub successor: Signer<'info>,
    #[account(mut, seeds = [b"config", config.seed_authority.as_ref()], bump = config.bump,
        constraint = config.pending_admin == successor.key() @ ProtocolError::Unauthorized)]
    pub config: Account<'info, Config>,
}

pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(
        Clock::get()?.unix_timestamp >= config.admin_after,
        ProtocolError::AdminDelay
    );
    config.admin = ctx.accounts.successor.key();
    config.pending_admin = Pubkey::default();
    config.admin_after = 0;
    Ok(())
}

#[derive(Accounts)]
pub struct Pause<'info> {
    pub guardian: Signer<'info>,
    #[account(mut, seeds = [b"config", config.seed_authority.as_ref()], bump = config.bump,
        constraint = config.roles.guardian == guardian.key() @ ProtocolError::Unauthorized)]
    pub config: Account<'info, Config>,
}

pub fn pause(ctx: Context<Pause>, paused: bool, reason: [u8; 32]) -> Result<()> {
    require!(
        reason != [0; 32] && paused != ctx.accounts.config.paused,
        ProtocolError::InvalidTerms
    );
    ctx.accounts.config.paused = paused;
    Ok(())
}

#[derive(Accounts)]
#[instruction(id: [u8;32], terms: Terms)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config", config.seed_authority.as_ref()], bump = config.bump,
        constraint = config.roles.market_admin == admin.key() @ ProtocolError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(address = config.quote_mint)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(seeds = [b"pool", config.key().as_ref(), quote_mint.key().as_ref()], bump = quote_pool.bump,
        constraint = quote_pool.mint == quote_mint.key() @ ProtocolError::InvalidAsset)]
    pub quote_pool: Box<Account<'info, AssetPool>>,
    #[account(seeds = [b"pool-vault", quote_pool.key().as_ref()], bump = quote_pool.vault_bump,
        constraint = quote_vault.mint == quote_mint.key() @ ProtocolError::InvalidAsset,
        constraint = quote_vault.owner == quote_pool.key() @ ProtocolError::InvalidAccount)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init, payer = admin, space = Market::allocation_size(terms.metadata_uri.len(), 0),
        seeds = [b"market", config.key().as_ref(), &id], bump)]
    pub market: Box<Account<'info, Market>>,
    pub system_program: Program<'info, System>,
}

/// A market starts with the deployment quote only. Base legs (one per
/// whitelisted issuer token of the same asset) are listed with `add_base`.
pub fn create_market(ctx: Context<CreateMarket>, id: [u8; 32], terms: Terms) -> Result<()> {
    token_policy::validate_mint(&ctx.accounts.quote_mint.to_account_info())?;
    require!(
        ctx.accounts.quote_pool.admitted == 0,
        ProtocolError::UnsupportedTokenExtension
    );
    require!(
        ctx.accounts.quote_vault.amount >= ctx.accounts.quote_pool.liability,
        ProtocolError::Insolvent
    );
    require!(
        id != [0; 32] && terms.condition != [0; 32] && terms.rules_hash != [0; 32],
        ProtocolError::InvalidTerms
    );
    require!(
        (terms.yes_index, terms.no_index) == (1, 2) || (terms.yes_index, terms.no_index) == (2, 1),
        ProtocolError::InvalidTerms
    );
    require!(
        !terms.metadata_uri.is_empty() && terms.metadata_uri.len() <= 512,
        ProtocolError::InvalidTerms
    );
    require!(
        hashv(&[terms.metadata_uri.as_bytes()]).to_bytes() == terms.metadata_hash,
        ProtocolError::Commitment
    );
    require!(
        terms.trading_open >= 0
            && terms.trading_cutoff > terms.trading_open
            && terms.trading_cutoff > Clock::get()?.unix_timestamp,
        ProtocolError::InvalidTerms
    );
    require!(
        terms.share_decimals <= MAX_SHARE_DECIMALS,
        ProtocolError::InvalidTerms
    );
    checked(terms.caps().validate())?;
    let market = &mut ctx.accounts.market;
    market.ledgers();
    market.config = ctx.accounts.config.key();
    market.id = id;
    market.terms = terms;
    market.mints[underlying(QUOTE)] = ctx.accounts.quote_mint.key();
    market.decimals[QUOTE] = ctx.accounts.quote_mint.decimals;
    market.pool_bumps[QUOTE] = ctx.accounts.quote_pool.bump;
    market.vaults_initialized = 1 << underlying(QUOTE);
    market.state = rules::SCHEDULED;
    market.bump = ctx.bumps.market;
    emit!(Change {
        market: market.key(),
        account: ctx.accounts.admin.key(),
        kind: 1,
        amount: 0,
        asset: 0
    });
    Ok(())
}

pub const MAX_SHARE_DECIMALS: u8 = 18;
/// 10^19 is the largest power of ten in u64.
pub const MAX_SCALE_EXPONENT: u8 = 19;

#[derive(Accounts)]
pub struct AddBase<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [b"config", config.seed_authority.as_ref()], bump = config.bump,
        constraint = config.roles.market_admin == admin.key() @ ProtocolError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, has_one = config, seeds = [b"market", config.key().as_ref(), &market.id], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(owner = token_program.key())]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(seeds = [b"pool", config.key().as_ref(), mint.key().as_ref()], bump = pool.bump,
        has_one = mint, has_one = token_program)]
    pub pool: Box<Account<'info, AssetPool>>,
    #[account(seeds = [b"pool-vault", pool.key().as_ref()], bump = pool.vault_bump,
        token::mint = mint, token::authority = pool, token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Whitelist one issuer's token of the market's asset as a new base leg. Its
/// claims are backed only by that token. The unified book trades share units:
/// each fill converts to this issuer's raw units at its live multiplier.
pub fn add_base(ctx: Context<AddBase>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let mint = ctx.accounts.mint.key();
    let decimals = ctx.accounts.mint.decimals;
    let market = &mut ctx.accounts.market;
    require!(
        [rules::SCHEDULED, rules::OPEN].contains(&market.state)
            && now < market.terms.trading_cutoff,
        ProtocolError::InvalidState
    );
    require!(
        (market.bases as usize) < MAX_BASES,
        ProtocolError::InvalidAsset
    );
    require!(
        (0..market.collaterals()).all(|c| market.mints[underlying(c)] != mint),
        ProtocolError::InvalidAsset
    );
    let exponent = decimals
        .checked_sub(market.terms.share_decimals)
        .filter(|e| *e <= MAX_SCALE_EXPONENT)
        .ok_or_else(|| error!(ProtocolError::InvalidTerms))?;
    let scale = 10u64.pow(exponent as u32);
    let state = token_policy::validate_admitted(
        &ctx.accounts.mint.to_account_info(),
        ctx.accounts.pool.admitted,
    )?;
    require!(!state.paused, ProtocolError::IssuerPaused);
    // Every admissible order converts without overflow, rounding up, at any
    // multiplier inside the band (the smallest is 4/5 of the listing value).
    checked(rules::base_raw(
        market.terms.max_quantity,
        scale,
        state.multiplier,
        true,
    ))?
    .checked_mul(5)
    .ok_or_else(|| error!(ProtocolError::InvalidTerms))?;
    // One step still delivers at least one raw unit at the top of the band.
    require!(
        checked(rules::base_raw(
            market.terms.step,
            scale,
            state.multiplier,
            false
        ))? >= 2,
        ProtocolError::InvalidTerms
    );
    require!(!ctx.accounts.vault.is_frozen(), ProtocolError::LegHalted);
    require!(
        ctx.accounts.vault.amount >= ctx.accounts.pool.liability,
        ProtocolError::Insolvent
    );
    let collateral = market.bases as usize + 1;
    market.mints[underlying(collateral)] = mint;
    market.decimals[collateral] = decimals;
    market.pool_bumps[collateral] = ctx.accounts.pool.bump;
    market.legs[collateral - 1] = BaseLeg {
        scale,
        multiplier: state.multiplier,
        active: true,
    };
    market.vaults_initialized |= 1 << underlying(collateral);
    market.bases += 1;
    emit!(Change {
        market: market.key(),
        account: ctx.accounts.admin.key(),
        kind: 15,
        amount: scale,
        asset: collateral as u8
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetBase<'info> {
    pub actor: Signer<'info>,
    #[account(seeds = [b"config", config.seed_authority.as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, has_one = config, seeds = [b"market", config.key().as_ref(), &market.id], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
}

/// Delist (guardian or market admin) or relist (market admin) a base leg.
/// A delisted leg accepts no new exposure; its resting asks become publicly
/// releasable. Existing claims always remain mergeable and redeemable.
pub fn set_base(ctx: Context<SetBase>, collateral: u8, active: bool) -> Result<()> {
    let actor = ctx.accounts.actor.key();
    let roles = &ctx.accounts.config.roles;
    require!(
        actor == roles.market_admin || (!active && actor == roles.guardian),
        ProtocolError::Unauthorized
    );
    let market = &mut ctx.accounts.market;
    let c = usize::from(collateral);
    market.leg(c)?;
    require!(
        market.legs[c - 1].active != active,
        ProtocolError::InvalidState
    );
    market.legs[c - 1].active = active;
    emit!(Change {
        market: market.key(),
        account: actor,
        kind: 16,
        amount: u64::from(active),
        asset: collateral
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Lifecycle<'info> {
    pub actor: Signer<'info>,
    #[account(seeds = [b"config", config.seed_authority.as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, has_one = config, seeds = [b"market", config.key().as_ref(), &market.id], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
}

pub fn lifecycle(ctx: Context<Lifecycle>, action: u8, commitment: [u8; 32]) -> Result<()> {
    let actor = ctx.accounts.actor.key();
    let roles = &ctx.accounts.config.roles;
    let market = &mut ctx.accounts.market;
    let now = Clock::get()?.unix_timestamp;
    match action {
        0 => {
            require_keys_eq!(actor, roles.market_admin, ProtocolError::Unauthorized);
            require!(
                market.state == rules::SCHEDULED
                    && market.openable()
                    && now >= market.terms.trading_open
                    && now < market.terms.trading_cutoff,
                ProtocolError::InvalidState
            );
            market.state = rules::OPEN;
        }
        1 => {
            require!(
                actor == roles.market_admin || actor == roles.guardian,
                ProtocolError::Unauthorized
            );
            require!(
                commitment != [0; 32] && [rules::SCHEDULED, rules::OPEN].contains(&market.state),
                ProtocolError::InvalidState
            );
            market.state = rules::FROZEN;
        }
        2 => {
            require!(
                market.state == rules::OPEN && now >= market.terms.trading_cutoff,
                ProtocolError::InvalidState
            );
            market.state = rules::FROZEN;
        }
        3 => {
            require_keys_eq!(actor, roles.market_admin, ProtocolError::Unauthorized);
            require!(
                market.state == rules::FROZEN && commitment != [0; 32],
                ProtocolError::InvalidState
            );
            market.resolution_commitment = commitment;
            market.state = rules::AWAITING;
        }
        4 => {
            require_keys_eq!(actor, roles.market_admin, ProtocolError::Unauthorized);
            require!(
                market.state == rules::REDEEMABLE && commitment != [0; 32],
                ProtocolError::InvalidState
            );
            market.state = rules::ARCHIVED;
        }
        _ => return err!(ProtocolError::InvalidState),
    }
    emit!(Change {
        market: market.key(),
        account: actor,
        kind: 2,
        amount: market.state as u64,
        asset: 0
    });
    Ok(())
}

pub fn resolution_hash(
    config: &Pubkey,
    market: &Pubkey,
    yes: u8,
    no: u8,
    evidence: &[u8; 32],
    uri: &str,
) -> [u8; 32] {
    hashv(&[
        b"PROBABL_SOLANA_RESOLUTION_V1",
        crate::ID.as_ref(),
        config.as_ref(),
        market.as_ref(),
        &[yes, no],
        evidence,
        &hashv(&[uri.as_bytes()]).to_bytes(),
    ])
    .to_bytes()
}

/// Resolution grows the market by exactly the evidence URI; the resolution
/// admin pays its rent.
#[derive(Accounts)]
#[instruction(yes: u8, no: u8, evidence: [u8; 32], uri: String)]
pub struct Resolve<'info> {
    #[account(mut)]
    pub actor: Signer<'info>,
    #[account(seeds = [b"config", config.seed_authority.as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, has_one = config, seeds = [b"market", config.key().as_ref(), &market.id], bump = market.bump,
        realloc = Market::allocation_size(market.terms.metadata_uri.len(), uri.len()),
        realloc::payer = actor, realloc::zero = false)]
    pub market: Box<Account<'info, Market>>,
    pub system_program: Program<'info, System>,
}

pub fn resolve(
    ctx: Context<Resolve>,
    yes: u8,
    no: u8,
    evidence: [u8; 32],
    uri: String,
) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.actor.key(),
        ctx.accounts.config.roles.resolution_admin,
        ProtocolError::Unauthorized
    );
    checked(rules::payout(yes, no))?;
    require!(
        evidence != [0; 32] && !uri.is_empty() && uri.len() <= 512,
        ProtocolError::InvalidTerms
    );
    let market = &mut ctx.accounts.market;
    require!(market.state == rules::AWAITING, ProtocolError::InvalidState);
    require!(
        market.resolution_commitment
            == resolution_hash(&market.config, &market.key(), yes, no, &evidence, &uri),
        ProtocolError::Commitment
    );
    market.payouts = [yes, no];
    market.evidence = evidence;
    market.evidence_uri = uri;
    market.resolved_at = Clock::get()?.unix_timestamp;
    market.resolution_commitment = [0; 32];
    market.state = rules::REDEEMABLE;
    emit!(Change {
        market: market.key(),
        account: ctx.accounts.actor.key(),
        kind: 3,
        amount: 0,
        asset: 0
    });
    Ok(())
}
