use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;
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
    pub base_mint: InterfaceAccount<'info, Mint>,
    #[account(address = config.quote_mint)]
    pub quote_mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = admin, space = Market::allocation_size(terms.metadata_uri.len(), None),
        seeds = [b"market", config.key().as_ref(), &id], bump)]
    pub market: Box<Account<'info, Market>>,
    pub system_program: Program<'info, System>,
}

pub fn create_market(ctx: Context<CreateMarket>, id: [u8; 32], terms: Terms) -> Result<()> {
    crate::token_policy::validate_mint(&ctx.accounts.base_mint.to_account_info())?;
    crate::token_policy::validate_mint(&ctx.accounts.quote_mint.to_account_info())?;
    require_keys_neq!(
        ctx.accounts.base_mint.key(),
        ctx.accounts.quote_mint.key(),
        ProtocolError::InvalidAsset
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
    checked(terms.caps().validate())?;
    let market = &mut ctx.accounts.market;
    market.config = ctx.accounts.config.key();
    market.id = id;
    market.terms = terms;
    market.mints[0] = ctx.accounts.base_mint.key();
    market.mints[1] = ctx.accounts.quote_mint.key();
    market.decimals = [
        ctx.accounts.base_mint.decimals,
        ctx.accounts.quote_mint.decimals,
    ];
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
                    && market.vaults_initialized == 63
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

pub fn resolve(
    ctx: Context<Lifecycle>,
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
