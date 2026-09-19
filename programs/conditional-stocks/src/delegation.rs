//! Trading-only capabilities. Grants are immutable except for budget consumption
//! and irreversible revocation. Never close/reinitialize them or reuse a key.
use crate::state::*;
use anchor_lang::prelude::*;

pub const TRADE: u8 = 1;
pub const CANCEL: u8 = 2;
pub const MAX_GRANT_LIFETIME: i64 = 90 * 24 * 60 * 60;

#[account]
#[derive(InitSpace)]
pub struct TradingDelegate {
    pub config: Pubkey,
    pub owner: Pubkey,
    pub delegate: Pubkey,
    /// Zero explicitly grants all markets in this config; otherwise one market.
    pub market: Pubkey,
    pub epoch: u64,
    pub expires_at: i64,
    /// Raw quote-token units, charged at the submitted limit on BOTH sides.
    pub max_order_quote: u64,
    pub remaining_quote: u64,
    pub max_fee_bps: u16,
    pub permissions: u8,
    pub revoked: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct DelegateLimits {
    pub expires_at: i64,
    pub max_order_quote: u64,
    pub total_quote: u64,
    pub max_fee_bps: u16,
    pub permissions: u8,
}
impl DelegateLimits {
    pub fn validate(&self, now: i64) -> Result<()> {
        require!(
            self.expires_at > now
                && self
                    .expires_at
                    .checked_sub(now)
                    .is_some_and(|d| d <= MAX_GRANT_LIFETIME)
                && self.max_order_quote > 0
                && self.total_quote >= self.max_order_quote
                && self.max_fee_bps <= protocol_core::MAX_FEE_BPS
                && (self.permissions == TRADE || self.permissions == TRADE | CANCEL),
            ProtocolError::InvalidDelegation
        );
        Ok(())
    }
}

#[derive(Accounts)]
pub struct ApproveDelegate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: Only identifies the signing key; does not grant custody authority.
    pub delegate: UncheckedAccount<'info>,
    #[account(seeds = [b"config", config.seed_authority.as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(init_if_needed, payer = owner, space = 8 + Trader::INIT_SPACE,
        seeds = [b"trader", config.key().as_ref(), owner.key().as_ref()], bump)]
    pub trader: Account<'info, Trader>,
    #[account(init, payer = owner, space = 8 + TradingDelegate::INIT_SPACE,
        seeds = [b"delegate", config.key().as_ref(), owner.key().as_ref(), delegate.key().as_ref()], bump)]
    pub delegation: Account<'info, TradingDelegate>,
    #[account(has_one = config,
        seeds = [b"market", config.key().as_ref(), &market.id], bump = market.bump)]
    pub market: Option<Box<Account<'info, Market>>>,
    pub system_program: Program<'info, System>,
}

pub fn approve_delegate(ctx: Context<ApproveDelegate>, limits: DelegateLimits) -> Result<()> {
    limits.validate(Clock::get()?.unix_timestamp)?;
    require_keys_neq!(
        ctx.accounts.delegate.key(),
        Pubkey::default(),
        ProtocolError::InvalidAddress
    );
    require_keys_neq!(
        ctx.accounts.delegate.key(),
        ctx.accounts.owner.key(),
        ProtocolError::InvalidDelegation
    );
    // Existing nonce and delegation epoch are NEVER reset by initialization.
    let trader = &mut ctx.accounts.trader;
    trader.config = ctx.accounts.config.key();
    trader.owner = ctx.accounts.owner.key();
    trader.bump = ctx.bumps.trader;
    let grant = &mut ctx.accounts.delegation;
    grant.set_inner(TradingDelegate {
        config: ctx.accounts.config.key(),
        owner: ctx.accounts.owner.key(),
        delegate: ctx.accounts.delegate.key(),
        market: ctx
            .accounts
            .market
            .as_ref()
            .map_or(Pubkey::default(), |m| m.key()),
        epoch: trader.delegation_epoch,
        expires_at: limits.expires_at,
        max_order_quote: limits.max_order_quote,
        remaining_quote: limits.total_quote,
        max_fee_bps: limits.max_fee_bps,
        permissions: limits.permissions,
        revoked: false,
        bump: ctx.bumps.delegation,
    });
    emit!(DelegateApproved {
        delegation: grant.key(),
        owner: grant.owner,
        delegate: grant.delegate,
        config: grant.config,
        market: grant.market,
        epoch: grant.epoch,
        limits
    });
    Ok(())
}

#[derive(Accounts)]
pub struct RevokeDelegate<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner,
        seeds = [b"delegate", delegation.config.as_ref(), owner.key().as_ref(), delegation.delegate.as_ref()], bump = delegation.bump)]
    pub delegation: Account<'info, TradingDelegate>,
}
pub fn revoke_delegate(ctx: Context<RevokeDelegate>) -> Result<()> {
    ctx.accounts.delegation.revoked = true;
    emit!(DelegateRevoked {
        delegation: ctx.accounts.delegation.key(),
        owner: ctx.accounts.owner.key()
    });
    Ok(())
}

#[derive(Accounts)]
pub struct RevokeAllDelegates<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner,
        seeds = [b"trader", trader.config.as_ref(), owner.key().as_ref()], bump = trader.bump)]
    pub trader: Account<'info, Trader>,
}
pub fn revoke_all_delegates(ctx: Context<RevokeAllDelegates>) -> Result<()> {
    let trader = &mut ctx.accounts.trader;
    trader.delegation_epoch = add(trader.delegation_epoch, 1)?;
    emit!(DelegatesRevoked {
        config: trader.config,
        owner: trader.owner,
        epoch: trader.delegation_epoch
    });
    Ok(())
}

impl TradingDelegate {
    pub fn identity(
        &self,
        address: &Pubkey,
        config: &Pubkey,
        owner: &Pubkey,
        delegate: &Pubkey,
    ) -> Result<()> {
        require!(
            self.config == *config && self.owner == *owner && self.delegate == *delegate,
            ProtocolError::InvalidDelegation
        );
        let expected = Pubkey::create_program_address(
            &[
                b"delegate",
                config.as_ref(),
                owner.as_ref(),
                delegate.as_ref(),
                &[self.bump],
            ],
            &crate::ID,
        )
        .map_err(|_| error!(ProtocolError::InvalidDelegation))?;
        require_keys_eq!(*address, expected, ProtocolError::InvalidDelegation);
        Ok(())
    }
    pub fn active(&self, epoch: u64, now: i64) -> bool {
        !self.revoked && self.epoch == epoch && now < self.expires_at
    }
    pub fn authorize(&self, market: &Pubkey, epoch: u64, now: i64, permission: u8) -> Result<()> {
        require!(self.active(epoch, now), ProtocolError::DelegationInactive);
        require!(
            (self.market == Pubkey::default() || self.market == *market)
                && self.permissions & permission == permission,
            ProtocolError::InvalidDelegation
        );
        Ok(())
    }
    pub fn charge(&mut self, terms: &OrderTerms, notional: u64) -> Result<()> {
        require!(
            terms.recipient == self.owner
                && terms.expiry <= self.expires_at
                && terms.max_fee_bps <= self.max_fee_bps
                && terms.bound_nonce() == Some(terms.nonce),
            ProtocolError::InvalidDelegation
        );
        require!(
            notional > 0 && notional <= self.max_order_quote && notional <= self.remaining_quote,
            ProtocolError::DelegateBudget
        );
        // Non-refundable lifetime turnover allowance: cancel/requote/IOC cannot
        // recycle a budget. Failed transactions roll this debit back atomically.
        self.remaining_quote = sub(self.remaining_quote, notional)?;
        Ok(())
    }
}

pub fn read_grant(info: &AccountInfo) -> Result<TradingDelegate> {
    require_keys_eq!(*info.owner, crate::ID, ProtocolError::InvalidDelegation);
    TradingDelegate::try_deserialize(&mut info.try_borrow_data()?.as_ref())
}

#[event]
pub struct DelegateApproved {
    pub delegation: Pubkey,
    pub config: Pubkey,
    pub owner: Pubkey,
    pub delegate: Pubkey,
    pub market: Pubkey,
    pub epoch: u64,
    pub limits: DelegateLimits,
}
#[event]
pub struct DelegateRevoked {
    pub delegation: Pubkey,
    pub owner: Pubkey,
}
#[event]
pub struct DelegatesRevoked {
    pub config: Pubkey,
    pub owner: Pubkey,
    pub epoch: u64,
}
