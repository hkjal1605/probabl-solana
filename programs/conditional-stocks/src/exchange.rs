use crate::delegation::{self, TradingDelegate};
use crate::invariants::{self, ClaimSnapshot};
use crate::pool::{self, AssetPool, CreditFrame};
use crate::{custody::mint_claim, state::*};
use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use anchor_spl::token_interface::TokenAccount as InterfaceTokenAccount;
use protocol_core as rules;

#[derive(Accounts)]
pub struct InvalidateNonce<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner,
        seeds = [b"trader", trader.config.as_ref(), owner.key().as_ref()], bump = trader.bump)]
    pub trader: Account<'info, Trader>,
}

pub fn invalidate_nonce(ctx: Context<InvalidateNonce>, minimum: u64) -> Result<()> {
    require!(
        minimum > ctx.accounts.trader.minimum_nonce,
        ProtocolError::InvalidTerms
    );
    ctx.accounts.trader.minimum_nonce = minimum;
    emit!(Change {
        market: ctx.accounts.trader.config,
        account: ctx.accounts.owner.key(),
        kind: 11,
        amount: minimum,
        asset: 0
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Cancel<'info> {
    pub actor: Signer<'info>,
    #[account(mut, seeds = [b"market", market.config.as_ref(), &market.id], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, has_one = market,
        seeds = [b"order", market.key().as_ref(), order.owner.as_ref(), &order.terms.salt], bump = order.bump)]
    pub order: Box<Account<'info, Order>>,
    #[account(mut, has_one = market, constraint = wallet.owner == order.owner @ ProtocolError::InvalidAccount,
        seeds = [b"wallet", market.key().as_ref(), order.owner.as_ref()], bump = wallet.bump)]
    pub wallet: Box<Account<'info, Wallet>>,
    #[account(constraint = trader.owner == order.owner @ ProtocolError::InvalidAccount,
        constraint = trader.config == market.config @ ProtocolError::InvalidAccount,
        seeds = [b"trader", market.config.as_ref(), order.owner.as_ref()], bump = trader.bump)]
    pub trader: Box<Account<'info, Trader>>,
    pub delegation: Option<Box<Account<'info, TradingDelegate>>>,
}

pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
    let order = &mut ctx.accounts.order;
    require!(order.status == 1, ProtocolError::InvalidOrder);
    let now = Clock::get()?.unix_timestamp;
    // An ask on a delisted leg can never fill again: anyone may release it.
    let delisted = order.terms.side == 1
        && ctx
            .accounts
            .market
            .leg(order.terms.collateral())
            .map_or(true, |leg| !leg.active);
    let public_release = delisted
        || rules::releasable(
            ctx.accounts.market.state,
            now,
            order.terms.expiry,
            order.terms.nonce,
            ctx.accounts.trader.minimum_nonce,
        );
    let mut delegated_cancel = false;
    if let Some(grant) = &ctx.accounts.delegation {
        require_keys_neq!(
            order.delegate,
            Pubkey::default(),
            ProtocolError::InvalidDelegation
        );
        grant.identity(
            &grant.key(),
            &ctx.accounts.market.config,
            &order.owner,
            &order.delegate,
        )?;
        // Anyone can release a revoked/expired delegation's resting reservation.
        delegated_cancel = !grant.active(ctx.accounts.trader.delegation_epoch, now);
        if !delegated_cancel && !public_release && ctx.accounts.actor.key() == order.delegate {
            grant.authorize(
                &order.market,
                ctx.accounts.trader.delegation_epoch,
                now,
                delegation::CANCEL,
            )?;
            delegated_cancel = true;
        }
    }
    require!(
        ctx.accounts.actor.key() == order.owner || delegated_cancel || public_release,
        ProtocolError::Unauthorized
    );
    let asset = order.terms.asset();
    let hydrated = if !is_claim(asset) {
        require!(
            ctx.remaining_accounts.len() == 1,
            ProtocolError::InvalidAccount
        );
        Some(pool::hydrate_one(
            &ctx.remaining_accounts[0],
            &mut ctx.accounts.market,
            &mut ctx.accounts.wallet,
            asset,
        )?)
    } else {
        require!(
            ctx.remaining_accounts.is_empty(),
            ProtocolError::InvalidAccount
        );
        None
    };
    release(&mut ctx.accounts.market, order, &mut ctx.accounts.wallet)?;
    if let Some((frame, before)) = hydrated {
        pool::flush_one(
            frame,
            before,
            &ctx.remaining_accounts[0],
            &mut ctx.accounts.market,
            &mut ctx.accounts.wallet,
        )?;
    }
    emit!(Change {
        market: ctx.accounts.market.key(),
        account: order.key(),
        kind: 12,
        amount: 0,
        asset: 0
    });
    Ok(())
}

pub(crate) fn release(market: &mut Market, order: &mut Order, wallet: &mut Wallet) -> Result<()> {
    let asset = order.terms.asset();
    market.escrow[asset] = market.escrow[asset]
        .checked_sub(order.reserved as u128)
        .ok_or_else(|| error!(ProtocolError::Insolvent))?;
    market.credit(wallet, asset, order.reserved)?;
    reduce_exposure(market, wallet, order.open_notional)?;
    order.remaining = 0;
    order.reserved = 0;
    order.open_notional = 0;
    order.status = 3;
    Ok(())
}

fn reduce_exposure(market: &mut Market, wallet: &mut Wallet, amount: u64) -> Result<()> {
    market.open_notional = market
        .open_notional
        .checked_sub(amount as u128)
        .ok_or_else(|| error!(ProtocolError::Insolvent))?;
    wallet.open_notional = wallet
        .open_notional
        .checked_sub(amount as u128)
        .ok_or_else(|| error!(ProtocolError::Insolvent))?;
    Ok(())
}

#[derive(Accounts)]
#[instruction(terms: OrderTerms)]
pub struct Place<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: Ownership is bound to the canonical participant wallet and an
    /// owner signature or canonical, bounded TradingDelegate in the handler.
    pub owner: UncheckedAccount<'info>,
    #[account(seeds = [b"config", config.seed_authority.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, has_one = config, seeds = [b"market", config.key().as_ref(), &market.id], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(init, payer = authority, space = 8 + Order::INIT_SPACE,
        seeds = [b"order", market.key().as_ref(), owner.key().as_ref(), &terms.salt], bump)]
    pub order: Box<Account<'info, Order>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    #[account(seeds = [b"pool", config.key().as_ref(), market.mints[underlying(QUOTE)].as_ref()], bump = quote_pool.bump)]
    pub quote_pool: Box<Account<'info, AssetPool>>,
    #[account(seeds = [b"pool-vault", quote_pool.key().as_ref()], bump = quote_pool.vault_bump,
        constraint = quote_vault.mint == market.mints[underlying(QUOTE)] @ ProtocolError::InvalidAsset,
        constraint = quote_vault.owner == quote_pool.key() @ ProtocolError::InvalidAccount)]
    pub quote_vault: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,
    #[account(mut)]
    pub delegation: Option<Box<Account<'info, TradingDelegate>>>,
}

/// One collateral whose claims this placement may mint: the quote, and each
/// base leg named in `touched` (the legs of every ask involved).
struct Touched {
    collateral: usize,
    /// Index of its YES claim mint in the remaining accounts; vault, NO mint
    /// and NO vault follow.
    claims: usize,
    underlying: u64,
    multiplier: u64,
    before: [ClaimSnapshot; 2],
    minted: [u64; 2],
}

fn touched_index(touched: &[Touched], collateral: usize) -> Result<usize> {
    touched
        .iter()
        .position(|t| t.collateral == collateral)
        .ok_or_else(|| error!(ProtocolError::InvalidAccount))
}

/// Wire order of remaining accounts:
/// 1. quote (YES mint, YES vault, NO mint, NO vault);
/// 2. per base leg in `touched`, ascending: pool, pool vault, issuer mint,
///    (YES mint, YES vault, NO mint, NO vault);
/// 3. one maker order per plan leg;
/// 4. unique (wallet, trader) PDA pairs per participant;
/// 5. asset-credit frames, then maker delegation grants.
///
/// Asks deliver exactly one base leg; bids accept a bitmask of legs. Quantities
/// are share units; each fill converts to the ask's raw issuer units at that
/// leg's live multiplier, rounding the delivery down.
pub fn place<'info>(
    ctx: Context<'info, Place<'info>>,
    terms: OrderTerms,
    plan: Plan,
    participants: u8,
    delegations: u8,
    touched: u8,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let market_key = ctx.accounts.market.key();
    let owner_key = ctx.accounts.owner.key();
    let config = &ctx.accounts.config;
    let market = &mut ctx.accounts.market;
    pool::empty_underlying(market)?;
    let legs = touched.count_ones() as usize;
    let prefix = 4 + LEG_ACCOUNTS * legs;
    let core_len = prefix + plan.legs.len() + 2 * usize::from(participants);
    require!(
        participants > 0
            && usize::from(participants) <= 2 * (plan.legs.len() + 1)
            && usize::from(delegations) <= plan.legs.len()
            && ctx.remaining_accounts.len() >= core_len + usize::from(delegations)
            && ctx.remaining_accounts.len() - core_len - usize::from(delegations) <= MAX_MAKERS + 2,
        ProtocolError::InvalidTerms
    );
    let (remaining, tail) = ctx.remaining_accounts.split_at(core_len);
    let (credit_accounts, grant_accounts) = tail.split_at(tail.len() - usize::from(delegations));
    if let Some(bound) = terms.bound_nonce() {
        require!(terms.nonce == bound, ProtocolError::InvalidTerms);
    }
    let listed = ((1u16 << market.bases) - 1) as u8;
    require!(
        terms.branch < 2
            && terms.side < 2
            && terms.funding < 2
            && terms.tif < 2
            && terms.max_fee_bps <= rules::MAX_FEE_BPS
            && terms.recipient != Pubkey::default()
            && terms.bases != 0
            && terms.bases & !listed == 0
            && (terms.side == 0 || single_base(terms.bases).is_some())
            && touched & !listed == 0,
        ProtocolError::InvalidTerms
    );
    checked(rules::trading(
        market.state,
        config.paused,
        now,
        market.terms.trading_open,
        market.terms.trading_cutoff,
    ))?;
    checked(rules::valid_expiry(
        now,
        terms.expiry,
        market.terms.trading_cutoff,
    ))?;
    checked(rules::guard(
        now,
        plan.deadline,
        terms.expiry,
        (plan.next_sequence, plan.maker_bps, plan.taker_bps),
        (
            market.sequence[terms.branch as usize],
            config.maker_bps,
            config.taker_bps,
        ),
    ))?;
    let wallet_start = prefix + plan.legs.len();
    require!(
        plan.legs.len() <= MAX_MAKERS && remaining.len() >= wallet_start + 2,
        ProtocolError::InvalidTerms
    );
    require!(
        (remaining.len() - wallet_start).is_multiple_of(2)
            && remaining.len() <= wallet_start + 4 * (plan.legs.len() + 1),
        ProtocolError::InvalidTerms
    );

    // No duplicate mutable account is accepted anywhere in this instruction's tail.
    for (index, info) in remaining.iter().enumerate() {
        let trader = index >= wallet_start && (index - wallet_start) % 2 == 1;
        require!(
            (index < prefix || trader || info.is_writable)
                && !remaining[..index].iter().any(|a| a.key == info.key),
            ProtocolError::InvalidAccount
        );
        require_keys_neq!(
            *info.key,
            ctx.accounts.order.key(),
            ProtocolError::InvalidAccount
        );
        require_keys_neq!(*info.key, market_key, ProtocolError::InvalidAccount);
    }

    // Quote custody (typed accounts) plus every touched base leg (untyped).
    let mut collaterals = Vec::<Touched>::with_capacity(1 + legs);
    pool::validate_pool(
        &ctx.accounts.quote_pool.to_account_info(),
        market,
        QUOTE,
        ctx.accounts.quote_vault.amount,
    )?;
    collaterals.push(Touched {
        collateral: QUOTE,
        claims: 0,
        underlying: ctx.accounts.quote_vault.amount,
        multiplier: rules::UNIT_MULTIPLIER,
        before: [ClaimSnapshot::default(); 2],
        minted: [0; 2],
    });
    let mut offset = 4;
    for collateral in 1..=MAX_BASES {
        if touched & (1 << (collateral - 1)) == 0 {
            continue;
        }
        let (underlying, multiplier) = pool::validate_leg(
            market,
            collateral,
            &remaining[offset],
            &remaining[offset + 1],
            &remaining[offset + 2],
            now,
        )?;
        collaterals.push(Touched {
            collateral,
            claims: offset + 3,
            underlying,
            multiplier,
            before: [ClaimSnapshot::default(); 2],
            minted: [0; 2],
        });
        offset += LEG_ACCOUNTS;
    }
    for t in collaterals.iter_mut() {
        for branch in 0..2 {
            t.before[branch] = invariants::read_claim(
                market,
                &market_key,
                claim(t.collateral, branch),
                &remaining[t.claims + 2 * branch],
                &remaining[t.claims + 2 * branch + 1],
            )?;
        }
        invariants::check_collateral(market, t.collateral, t.underlying, t.before)?;
    }

    // One bounded allocation, in account order. A linear lookup over <=18
    // participants avoids allocating tree nodes and remains alias-safe.
    let mut wallets = Vec::<Participant>::with_capacity((remaining.len() - wallet_start) / 2);
    for pair in remaining[wallet_start..].chunks_exact(2) {
        let info = &pair[0];
        require_keys_eq!(*info.owner, crate::ID, ProtocolError::InvalidAccount);
        let wallet = Wallet::try_deserialize(&mut info.try_borrow_data()?.as_ref())?;
        require!(pool::empty_wallet(&wallet), ProtocolError::InvalidAccount);
        require_keys_eq!(wallet.market, market_key, ProtocolError::InvalidAccount);
        let key = Pubkey::create_program_address(
            &[
                b"wallet",
                market_key.as_ref(),
                wallet.owner.as_ref(),
                &[wallet.bump],
            ],
            &crate::ID,
        )
        .map_err(|_| error!(ProtocolError::InvalidAccount))?;
        require_keys_eq!(key, *info.key, ProtocolError::InvalidAccount);
        let trader_info = &pair[1];
        require_keys_eq!(*trader_info.owner, crate::ID, ProtocolError::InvalidAccount);
        let trader = Trader::try_deserialize(&mut trader_info.try_borrow_data()?.as_ref())?;
        require_keys_eq!(trader.owner, wallet.owner, ProtocolError::InvalidAccount);
        require_keys_eq!(trader.config, market.config, ProtocolError::InvalidAccount);
        let trader_key = Pubkey::create_program_address(
            &[
                b"trader",
                market.config.as_ref(),
                wallet.owner.as_ref(),
                &[trader.bump],
            ],
            &crate::ID,
        )
        .map_err(|_| error!(ProtocolError::InvalidAccount))?;
        require_keys_eq!(trader_key, *trader_info.key, ProtocolError::InvalidAccount);
        require!(
            !wallets.iter().any(|p| p.wallet.owner == wallet.owner),
            ProtocolError::InvalidAccount
        );
        wallets.push(Participant {
            wallet,
            minimum_nonce: trader.minimum_nonce,
            delegation_epoch: trader.delegation_epoch,
        });
    }
    let mut pools = Vec::with_capacity(collaterals.len());
    pools.push((ctx.accounts.quote_pool.key(), QUOTE));
    let mut offset = 4;
    for t in collaterals.iter().skip(1) {
        pools.push((*remaining[offset].key, t.collateral));
        offset += LEG_ACCOUNTS;
    }
    let mut frames = Vec::with_capacity(credit_accounts.len());
    for (i, info) in credit_accounts.iter().enumerate() {
        require!(
            !credit_accounts[..i].iter().any(|a| a.key == info.key),
            ProtocolError::InvalidAccount
        );
        let frame = CreditFrame::load_for_pools(info, &pools)?;
        frame.hydrate(market, wallet(&mut wallets, &frame.credit.owner)?)?;
        frames.push(frame);
    }
    let conserved = market.liabilities()?;
    checked(rules::valid_nonce(
        terms.nonce,
        nonce(&wallets, &owner_key)?,
    ))?;
    let notional = checked(
        market
            .terms
            .caps()
            .validate_order(terms.quantity, terms.price),
    )?;

    let delegate_key = if ctx.accounts.authority.key() == owner_key {
        require!(
            ctx.accounts.delegation.is_none(),
            ProtocolError::InvalidDelegation
        );
        Pubkey::default()
    } else {
        let grant = ctx
            .accounts
            .delegation
            .as_mut()
            .ok_or_else(|| error!(ProtocolError::Unauthorized))?;
        grant.identity(
            &grant.key(),
            &market.config,
            &owner_key,
            &ctx.accounts.authority.key(),
        )?;
        grant.authorize(
            &market_key,
            epoch(&wallets, &owner_key)?,
            now,
            delegation::TRADE,
        )?;
        grant.charge(&terms, notional)?;
        ctx.accounts.authority.key()
    };
    wallet(&mut wallets, &terms.recipient)?;
    // Read each immutable maker grant once; readonly on maker-only paths.
    let mut grants = Vec::with_capacity(grant_accounts.len());
    for (i, info) in grant_accounts.iter().enumerate() {
        require!(
            !grant_accounts[..i].iter().any(|a| a.key == info.key),
            ProtocolError::InvalidDelegation
        );
        grants.push((info.key, delegation::read_grant(info)?));
    }
    // A credit frame is present for `owner` in `collateral`'s pool.
    let framed = |owner: &Pubkey, collateral: usize| {
        pools
            .iter()
            .find(|(_, c)| *c == collateral)
            .is_some_and(|(pool, _)| {
                frames
                    .iter()
                    .any(|f| f.credit.pool == *pool && f.credit.owner == *owner)
            })
    };

    // Planned makers that were filled, cancelled, closed, expired, nonce- or
    // delegation-invalidated or re-priced out of their fee cap since planning
    // are skipped, and a partially filled maker is capped to what remains:
    // concurrent book activity never fails a placement. A malformed plan
    // (wrong market/branch/side, uncrossed prices, missing accounts) still does.
    let mut used_legs = if terms.side == 1 { terms.bases } else { 0 };
    let mut makers = Vec::<(usize, Order, u64)>::with_capacity(plan.legs.len());
    let mut total = 0u64;
    for (i, leg) in plan.legs.iter().enumerate() {
        let info = &remaining[wallet_start - plan.legs.len() + i];
        if *info.owner != crate::ID {
            continue; // Retired: the order account was closed.
        }
        let order = Order::try_deserialize(&mut info.try_borrow_data()?.as_ref())?;
        require_keys_eq!(order.market, market_key, ProtocolError::InvalidAccount);
        let key = Pubkey::create_program_address(
            &[
                b"order",
                market_key.as_ref(),
                order.owner.as_ref(),
                &order.terms.salt,
                &[order.bump],
            ],
            &crate::ID,
        )
        .map_err(|_| error!(ProtocolError::InvalidAccount))?;
        require_keys_eq!(key, *info.key, ProtocolError::InvalidAccount);
        if order.status != 1 {
            continue;
        }
        let (bid, ask) = if terms.side == 0 {
            (&terms, &order.terms)
        } else {
            (&order.terms, &terms)
        };
        let base = ask.collateral();
        require!(
            leg.quantity > 0
                && order.terms.tif == 0
                && order.terms.branch == terms.branch
                && order.terms.side != terms.side
                && order.sequence < plan.next_sequence
                && bid.accepts(base),
            ProtocolError::StalePlan
        );
        if rules::valid_expiry(now, order.terms.expiry, market.terms.trading_cutoff).is_err()
            || rules::valid_nonce(order.terms.nonce, nonce(&wallets, &order.owner)?).is_err()
            || config.maker_bps > order.terms.max_fee_bps
        {
            continue;
        }
        if order.delegate != Pubkey::default() {
            let (address, grant) = grants
                .iter()
                .find(|(_, g)| g.owner == order.owner && g.delegate == order.delegate)
                .ok_or_else(|| error!(ProtocolError::InvalidDelegation))?;
            grant.identity(address, &market.config, &order.owner, &order.delegate)?;
            if grant
                .authorize(
                    &market_key,
                    epoch(&wallets, &order.owner)?,
                    now,
                    delegation::TRADE,
                )
                .is_err()
            {
                continue;
            }
        }
        wallet(&mut wallets, &order.terms.recipient)?;
        require!(config.taker_bps <= terms.max_fee_bps, ProtocolError::FeeCap);
        let quantity = leg.quantity.min(order.remaining);
        if terms.side == 0 {
            // Maker ask: its reservation must cover the live conversion, and
            // completing it returns the surplus to its funding pool credit.
            let slot = touched_index(&collaterals, base)?;
            let base_amount = market.raw(base, quantity, collaterals[slot].multiplier, false)?;
            if base_amount == 0
                || base_amount > order.reserved
                || (quantity == order.remaining
                    && order.reserved > base_amount
                    && order.terms.funding == 0
                    && !framed(&order.owner, base))
            {
                continue;
            }
        } else {
            // Maker bid: rounding improvement returns to its funding pool credit.
            let fill = checked(rules::fill(
                quantity,
                market.terms.step,
                order.remaining,
                quantity,
                order.terms.price,
                terms.price,
                true,
            ))?;
            if fill.improvement > 0 && order.terms.funding == 0 && !framed(&order.owner, QUOTE) {
                continue;
            }
        }
        used_legs |= 1 << (base - 1);
        total = add(total, quantity)?;
        makers.push((i, order, quantity));
    }
    require!(total <= terms.quantity, ProtocolError::InvalidTerms);
    require!(total >= plan.min_fill, ProtocolError::StalePlan);
    // Every leg a fill delivers (and a selling taker's own leg) is touched;
    // legs of skipped makers may remain touched.
    require!(used_legs & !touched == 0, ProtocolError::InvalidAccount);
    let asset = terms.asset();
    let reserved = if terms.side == 0 {
        notional
    } else {
        let base = terms.collateral();
        let multiplier = collaterals[touched_index(&collaterals, base)?].multiplier;
        market.raw(base, terms.quantity, multiplier, true)?
    };
    market.debit(wallet(&mut wallets, &owner_key)?, asset, reserved)?;
    market.escrow[asset] = market.escrow[asset]
        .checked_add(reserved as u128)
        .ok_or_else(|| error!(ProtocolError::Arithmetic))?;
    market.open_notional = market
        .open_notional
        .checked_add(notional as u128)
        .ok_or_else(|| error!(ProtocolError::Arithmetic))?;
    let owner_wallet = wallet(&mut wallets, &owner_key)?;
    owner_wallet.open_notional = owner_wallet
        .open_notional
        .checked_add(notional as u128)
        .ok_or_else(|| error!(ProtocolError::Arithmetic))?;
    let taker = &mut ctx.accounts.order;
    taker.market = market_key;
    taker.owner = owner_key;
    taker.delegate = delegate_key;
    taker.remaining = terms.quantity;
    taker.filled = 0;
    taker.reserved = reserved;
    taker.open_notional = notional;
    taker.sequence = market.sequence[terms.branch as usize];
    taker.status = 1;
    taker.bump = ctx.bumps.order;
    market.sequence[terms.branch as usize] = taker
        .sequence
        .checked_add(1)
        .ok_or_else(|| error!(ProtocolError::Arithmetic))?;
    taker.terms = terms;

    for (i, maker, quantity) in makers.iter_mut() {
        let (i, quantity) = (*i, *quantity);
        let taker_is_buy = taker.terms.side == 0;
        let taker_key = taker.key();
        let price = maker.terms.price;
        let (buy, sell): (&mut Order, &mut Order) = if taker_is_buy {
            (&mut **taker, maker)
        } else {
            (maker, &mut **taker)
        };
        let base = sell.terms.collateral();
        let slot = touched_index(&collaterals, base)?;
        let fill = checked(rules::fill(
            quantity,
            market.terms.step,
            buy.remaining,
            sell.remaining,
            buy.terms.price,
            sell.terms.price,
            !taker_is_buy,
        ))?;
        // Delivery rounds down: the buyer never receives more than the shares it paid for.
        let base_amount = market.raw(base, quantity, collaterals[slot].multiplier, false)?;
        require!(
            base_amount > 0 && base_amount <= sell.reserved,
            ProtocolError::StalePlan
        );
        let (buyer_fee, buyer_carry) = checked(rules::fee(
            base_amount,
            if taker_is_buy {
                config.taker_bps
            } else {
                config.maker_bps
            },
            buy.fee_carry,
        ))?;
        let (seller_fee, seller_carry) = checked(rules::fee(
            fill.quote,
            if taker_is_buy {
                config.maker_bps
            } else {
                config.taker_bps
            },
            sell.fee_carry,
        ))?;
        buy.fee_carry = buyer_carry;
        sell.fee_carry = seller_carry;
        market.escrow[buy.terms.asset()] = market.escrow[buy.terms.asset()]
            .checked_sub(fill.buyer_notional_reduction as u128)
            .ok_or_else(|| error!(ProtocolError::Insolvent))?;
        market.escrow[sell.terms.asset()] = market.escrow[sell.terms.asset()]
            .checked_sub(base_amount as u128)
            .ok_or_else(|| error!(ProtocolError::Insolvent))?;
        market.credit(
            wallet(&mut wallets, &buy.owner)?,
            buy.terms.asset(),
            fill.improvement,
        )?;
        reduce_exposure(
            market,
            wallet(&mut wallets, &buy.owner)?,
            fill.buyer_notional_reduction,
        )?;
        reduce_exposure(
            market,
            wallet(&mut wallets, &sell.owner)?,
            fill.seller_notional_reduction,
        )?;

        // Expected deltas come from the validated fills, independently of the
        // mint helpers and their changes to backing or credits.
        if sell.terms.funding == 0 {
            for minted in collaterals[slot].minted.iter_mut() {
                *minted = add(*minted, base_amount)?;
            }
        }
        if buy.terms.funding == 0 {
            for minted in collaterals[0].minted.iter_mut() {
                *minted = add(*minted, fill.quote)?;
            }
        }
        settle_asset(
            market,
            &mut wallets,
            base,
            sell.terms.funding,
            &sell.owner,
            &buy.terms.recipient,
            buy.terms.branch,
            base_amount,
            buyer_fee,
        )?;
        settle_asset(
            market,
            &mut wallets,
            QUOTE,
            buy.terms.funding,
            &buy.owner,
            &sell.terms.recipient,
            buy.terms.branch,
            fill.quote,
            seller_fee,
        )?;
        buy.remaining = fill.buyer_remaining;
        buy.filled = add(buy.filled, quantity)?;
        buy.reserved = fill.buyer_reserved;
        buy.open_notional = sub(buy.open_notional, fill.buyer_notional_reduction)?;
        sell.remaining = fill.seller_remaining;
        sell.filled = add(sell.filled, quantity)?;
        sell.reserved = sub(sell.reserved, base_amount)?;
        sell.open_notional = sub(sell.open_notional, fill.seller_notional_reduction)?;
        if buy.remaining == 0 {
            buy.status = 2;
        }
        if sell.remaining == 0 {
            sell.status = 2;
            // Round-down deliveries and dividend accrual leave a reservation
            // surplus once the ask completes; return it to the seller.
            refund_surplus(market, sell, wallet(&mut wallets, &sell.owner)?)?;
        }
        emit!(Trade {
            market: market_key,
            taker: taker_key,
            maker: *remaining[wallet_start - plan.legs.len() + i].key,
            branch: buy.terms.branch,
            base: base as u8,
            quantity,
            base_amount,
            price,
            quote: fill.quote,
            buyer_fee,
            seller_fee
        });
    }
    if taker.terms.tif == 1 && taker.remaining != 0 {
        release(market, taker, wallet(&mut wallets, &owner_key)?)?;
    }
    // A resting order must not cross an opposite order placed after its plan
    // (which it could not match); record this placement for later checks.
    let resting = taker.status == 1;
    let branch = taker.terms.branch as usize;
    // Retained in ticks (validated tick multiples): 9 bytes per placement.
    let ticks = u64::try_from(taker.terms.price / market.terms.tick)
        .map_err(|_| error!(ProtocolError::InvalidTerms))?;
    if resting {
        checked(rules::race_free(
            RECENT,
            plan.next_sequence,
            taker.sequence,
            taker.terms.side,
            u128::from(ticks),
            |slot| {
                let p = &market.recent[branch * RECENT + slot];
                (u128::from(p.ticks), p.side)
            },
        ))?;
    }
    market.recent[branch * RECENT + (taker.sequence % RECENT as u64) as usize] = Placement {
        ticks,
        side: if resting {
            taker.terms.side
        } else {
            rules::SIDE_NONE
        },
    };
    checked(market.terms.caps().final_exposure(
        wallet(&mut wallets, &owner_key)?.open_notional,
        market.open_notional,
    ))?;
    // Classic SPL claim mints have no hooks. Accumulate accounting per fill,
    // but mint once per asset, preserving independent expected-delta checks.
    for t in collaterals.iter_mut() {
        for branch in 0..2 {
            let (mint, vault) = (t.claims + 2 * branch, t.claims + 2 * branch + 1);
            mint_claim(
                market,
                market.to_account_info(),
                remaining[mint].clone(),
                remaining[vault].clone(),
                t.minted[branch],
            )?;
            // With no CPI for this mint/vault, the initial snapshot is still
            // current. Final liabilities are nevertheless checked below.
            let after = if t.minted[branch] != 0 {
                invariants::reload_claim(&remaining[mint], &remaining[vault])?
            } else {
                t.before[branch]
            };
            invariants::check_delta(t.before[branch], after, t.minted[branch], true)?;
            t.before[branch] = after;
        }
        invariants::check_collateral(market, t.collateral, t.underlying, t.before)?;
    }
    pool::conserved(market, conserved)?;
    for (frame, info) in frames.iter_mut().zip(credit_accounts) {
        frame.flush(info, market, wallet(&mut wallets, &frame.credit.owner)?)?;
    }
    pool::empty_underlying(market)?;
    for participant in &wallets {
        require!(
            pool::empty_wallet(&participant.wallet),
            ProtocolError::Insolvent
        );
    }
    // Serialization happens only after every leg and final cap check succeeds.
    // Solana rolls back token CPIs as well as state on every instruction/transaction error.
    for (i, maker, _) in &makers {
        maker.try_serialize(
            &mut remaining[wallet_start - plan.legs.len() + i]
                .try_borrow_mut_data()?
                .as_mut(),
        )?;
    }
    for (pair, participant) in remaining[wallet_start..].chunks_exact(2).zip(&wallets) {
        let info = &pair[0];
        participant
            .wallet
            .try_serialize(&mut info.try_borrow_mut_data()?.as_mut())?;
    }
    emit!(Change {
        market: market_key,
        account: taker.key(),
        kind: 13,
        amount: taker.remaining,
        asset: asset as u8
    });
    Ok(())
}

/// Return a completed ask's leftover base reservation to its funding asset.
pub(crate) fn refund_surplus(
    market: &mut Market,
    order: &mut Order,
    wallet: &mut Wallet,
) -> Result<()> {
    if order.reserved == 0 {
        return Ok(());
    }
    let asset = order.terms.asset();
    market.escrow[asset] = market.escrow[asset]
        .checked_sub(order.reserved as u128)
        .ok_or_else(|| error!(ProtocolError::Insolvent))?;
    market.credit(wallet, asset, order.reserved)?;
    order.reserved = 0;
    Ok(())
}

struct Participant {
    wallet: Wallet,
    minimum_nonce: u64,
    delegation_epoch: u64,
}

fn epoch(wallets: &[Participant], owner: &Pubkey) -> Result<u64> {
    wallets
        .iter()
        .find(|p| p.wallet.owner == *owner)
        .map(|p| p.delegation_epoch)
        .ok_or_else(|| error!(ProtocolError::InvalidAccount))
}

fn wallet<'a>(wallets: &'a mut [Participant], owner: &Pubkey) -> Result<&'a mut Wallet> {
    wallets
        .iter_mut()
        .find(|p| p.wallet.owner == *owner)
        .map(|p| &mut p.wallet)
        .ok_or_else(|| error!(ProtocolError::InvalidAccount))
}

fn nonce(wallets: &[Participant], owner: &Pubkey) -> Result<u64> {
    wallets
        .iter()
        .find(|p| p.wallet.owner == *owner)
        .map(|p| p.minimum_nonce)
        .ok_or_else(|| error!(ProtocolError::InvalidAccount))
}

#[allow(clippy::too_many_arguments)]
fn settle_asset(
    market: &mut Market,
    wallets: &mut [Participant],
    collateral: usize,
    funding: u8,
    funder: &Pubkey,
    recipient: &Pubkey,
    branch: u8,
    amount: u64,
    fee: u64,
) -> Result<()> {
    let active = claim(collateral, branch as usize);
    let inactive = claim(collateral, 1 - branch as usize);
    if funding == 0 {
        market.backing[collateral] = add(market.backing[collateral], amount)?;
        market.credit(wallet(wallets, funder)?, inactive, amount)?;
    }
    market.credit(wallet(wallets, recipient)?, active, sub(amount, fee)?)?;
    market.fees[active] = add(market.fees[active], fee)?;
    Ok(())
}
