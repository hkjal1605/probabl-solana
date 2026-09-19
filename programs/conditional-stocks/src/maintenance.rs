//! Bounded owner-authorized rent recovery. Trader invalidation is permanent:
//! never close it, and never permit a retired salt to be rebound to a new nonce.
use crate::delegation::{self, TradingDelegate};
use crate::pool::{self, CreditFrame};
use crate::{exchange::release, state::*};
use anchor_lang::prelude::*;
use protocol_core as rules;

#[derive(Accounts)]
pub struct RetireOrders<'info> {
    pub actor: Signer<'info>,
    /// CHECK: Exact wallet owner; retirement requires the same signer and refunds
    /// only this owner. Delegated cancellation cannot withdraw or reclaim rent.
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"market", market.config.as_ref(), &market.id], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, has_one = market, has_one = owner,
        seeds = [b"wallet", market.key().as_ref(), owner.key().as_ref()], bump = wallet.bump)]
    pub wallet: Account<'info, Wallet>,
    #[account(has_one = owner, constraint = trader.config == market.config @ ProtocolError::InvalidAccount,
        seeds = [b"trader", market.config.as_ref(), owner.key().as_ref()], bump = trader.bump)]
    pub trader: Account<'info, Trader>,
    pub delegation: Option<Box<Account<'info, TradingDelegate>>>,
}

#[event]
pub struct OrderRetired {
    pub market: Pubkey,
    pub account: Pubkey,
    /// Complete final account image, including discriminator. Finalized replay
    /// reconstructs historical orders even after their account rent is returned.
    pub data: Vec<u8>,
}

pub fn retire_orders<'info>(
    ctx: Context<'info, RetireOrders<'info>>,
    order_count: u8,
) -> Result<()> {
    process_orders(ctx, true, order_count)
}

pub fn cancel_orders<'info>(
    ctx: Context<'info, RetireOrders<'info>>,
    order_count: u8,
) -> Result<()> {
    process_orders(ctx, false, order_count)
}

fn process_orders<'info>(
    ctx: Context<'info, RetireOrders<'info>>,
    retire: bool,
    order_count: u8,
) -> Result<()> {
    let count = usize::from(order_count);
    let owner_signed = ctx.accounts.actor.key() == ctx.accounts.owner.key();
    let now = Clock::get()?.unix_timestamp;
    if owner_signed {
        require!(
            ctx.accounts.delegation.is_none(),
            ProtocolError::InvalidDelegation
        );
    } else {
        require!(!retire, ProtocolError::Unauthorized);
        let grant = ctx
            .accounts
            .delegation
            .as_ref()
            .ok_or_else(|| error!(ProtocolError::Unauthorized))?;
        grant.identity(
            &grant.key(),
            &ctx.accounts.market.config,
            &ctx.accounts.owner.key(),
            &ctx.accounts.actor.key(),
        )?;
        grant.authorize(
            &ctx.accounts.market.key(),
            ctx.accounts.trader.delegation_epoch,
            now,
            delegation::CANCEL,
        )?;
    }
    require!(
        count > 0
            && count <= MAX_MAKERS
            && ctx.remaining_accounts.len() >= count
            && ctx.remaining_accounts.len() <= count + 2,
        ProtocolError::InvalidTerms
    );
    let (orders, credits) = ctx.remaining_accounts.split_at(count);
    pool::empty_underlying(&ctx.accounts.market)?;
    let mut frames = Vec::with_capacity(credits.len());
    for (i, info) in credits.iter().enumerate() {
        require!(
            !credits[..i].iter().any(|a| a.key == info.key),
            ProtocolError::InvalidAccount
        );
        let frame = CreditFrame::load(info, &ctx.accounts.market)?;
        frame.hydrate(&mut ctx.accounts.market, &mut ctx.accounts.wallet)?;
        frames.push(frame);
    }
    let before = [
        ctx.accounts.market.liability(0)?,
        ctx.accounts.market.liability(1)?,
    ];
    let market_key = ctx.accounts.market.key();
    let owner_key = ctx.accounts.owner.key();
    let closed_market = permanently_closed(&ctx.accounts.market, Clock::get()?.unix_timestamp);
    for (i, info) in orders.iter().enumerate() {
        require!(
            info.is_writable && !orders[..i].iter().any(|a| a.key == info.key),
            ProtocolError::InvalidAccount
        );
        let mut order = Account::<Order>::try_from(info)?;
        require_keys_eq!(order.market, market_key, ProtocolError::InvalidAccount);
        require_keys_eq!(order.owner, owner_key, ProtocolError::Unauthorized);
        if !owner_signed {
            require_keys_eq!(
                order.delegate,
                ctx.accounts.actor.key(),
                ProtocolError::Unauthorized
            );
        }
        let expected = Pubkey::create_program_address(
            &[
                b"order",
                market_key.as_ref(),
                owner_key.as_ref(),
                &order.terms.salt,
                &[order.bump],
            ],
            &crate::ID,
        )
        .map_err(|_| error!(ProtocolError::InvalidAccount))?;
        require_keys_eq!(*info.key, expected, ProtocolError::InvalidAccount);
        require!(
            !retire
                || retirable(
                    &order.terms,
                    ctx.accounts.trader.minimum_nonce,
                    closed_market
                ),
            ProtocolError::InvalidOrder
        );
        // Idempotent for already-completed entries: a concurrent fill must not
        // prevent an emergency batch from cancelling its other open quotes.
        if order.status == 1 {
            release(
                &mut ctx.accounts.market,
                &mut order,
                &mut ctx.accounts.wallet,
            )?;
        }
        require!(
            [2, 3].contains(&order.status)
                && order.remaining == 0
                && order.reserved == 0
                && order.open_notional == 0,
            ProtocolError::InvalidOrder
        );
        if retire {
            let mut data = Vec::with_capacity(8 + Order::INIT_SPACE);
            order.try_serialize(&mut data)?;
            emit!(OrderRetired {
                market: market_key,
                account: *info.key,
                data
            });
            order.close(ctx.accounts.owner.to_account_info())?;
        } else {
            order.exit(&crate::ID)?;
            emit!(Change {
                market: market_key,
                account: *info.key,
                kind: 12,
                amount: 0,
                asset: 0
            });
        }
    }
    pool::conserved(&ctx.accounts.market, before)?;
    for (frame, info) in frames.iter_mut().zip(credits) {
        frame.flush(info, &mut ctx.accounts.market, &mut ctx.accounts.wallet)?;
    }
    pool::empty_underlying(&ctx.accounts.market)?;
    Ok(())
}

pub fn permanently_closed(market: &Market, now: i64) -> bool {
    now >= market.terms.trading_cutoff
        || [
            rules::FROZEN,
            rules::AWAITING,
            rules::REDEEMABLE,
            rules::ARCHIVED,
        ]
        .contains(&market.state)
}

pub fn retirable(terms: &OrderTerms, minimum_nonce: u64, closed_market: bool) -> bool {
    closed_market || (terms.bound_nonce() == Some(terms.nonce) && terms.nonce < minimum_nonce)
}

#[derive(Accounts)]
pub struct CompactMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config", config.seed_authority.as_ref()], bump = config.bump,
        constraint = config.roles.market_admin == admin.key() @ ProtocolError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, has_one = config,
        seeds = [b"market", config.key().as_ref(), &market.id], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
}

/// Shrink only, retaining room for any permitted future resolution URI. Refund
/// only rent released by shrinking; unsolicited lamport donations stay put.
pub fn compact_market(ctx: Context<CompactMarket>) -> Result<()> {
    let market = &ctx.accounts.market;
    let resolved = [rules::REDEEMABLE, rules::ARCHIVED].contains(&market.state);
    let size = Market::allocation_size(
        market.terms.metadata_uri.len(),
        resolved.then_some(market.evidence_uri.len()),
    );
    let info = market.to_account_info();
    require!(size <= info.data_len(), ProtocolError::InvalidAccount);
    let rent = Rent::get()?;
    let refund = rent
        .minimum_balance(info.data_len())
        .saturating_sub(rent.minimum_balance(size));
    require!(
        info.lamports() >= rent.minimum_balance(info.data_len()),
        ProtocolError::InvalidAccount
    );
    info.resize(size)?;
    info.sub_lamports(refund)?;
    ctx.accounts.admin.add_lamports(refund)?;
    emit!(Change {
        market: market.key(),
        account: ctx.accounts.admin.key(),
        kind: 14,
        amount: refund,
        asset: 0
    });
    Ok(())
}
