use crate::invariants::{self, ClaimSnapshot};
use crate::{custody::mint_claim, state::*};
use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use anchor_spl::token_interface::TokenAccount as InterfaceTokenAccount;
use protocol_core as rules;
use std::collections::{BTreeMap, BTreeSet};

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
    pub order: Account<'info, Order>,
    #[account(mut, has_one = market, constraint = wallet.owner == order.owner @ ProtocolError::InvalidAccount,
        seeds = [b"wallet", market.key().as_ref(), order.owner.as_ref()], bump = wallet.bump)]
    pub wallet: Account<'info, Wallet>,
    #[account(constraint = trader.owner == order.owner @ ProtocolError::InvalidAccount,
        constraint = trader.config == market.config @ ProtocolError::InvalidAccount,
        seeds = [b"trader", market.config.as_ref(), order.owner.as_ref()], bump = trader.bump)]
    pub trader: Account<'info, Trader>,
}

pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
    let order = &mut ctx.accounts.order;
    require!(order.status == 1, ProtocolError::InvalidOrder);
    require!(
        ctx.accounts.actor.key() == order.owner
            || rules::releasable(
                ctx.accounts.market.state,
                Clock::get()?.unix_timestamp,
                order.terms.expiry,
                order.terms.nonce,
                ctx.accounts.trader.minimum_nonce
            ),
        ProtocolError::Unauthorized
    );
    release(&mut ctx.accounts.market, order, &mut ctx.accounts.wallet)?;
    emit!(Change {
        market: ctx.accounts.market.key(),
        account: order.key(),
        kind: 12,
        amount: 0,
        asset: 0
    });
    Ok(())
}

fn release(market: &mut Market, order: &mut Order, wallet: &mut Wallet) -> Result<()> {
    let asset = order.terms.asset();
    market.escrow[asset] = market.escrow[asset]
        .checked_sub(order.reserved as u128)
        .ok_or(error!(ProtocolError::Insolvent))?;
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
        .ok_or(error!(ProtocolError::Insolvent))?;
    wallet.open_notional = wallet
        .open_notional
        .checked_sub(amount as u128)
        .ok_or(error!(ProtocolError::Insolvent))?;
    Ok(())
}

#[derive(Accounts)]
#[instruction(terms: OrderTerms)]
pub struct Place<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"config", config.seed_authority.as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, has_one = config, seeds = [b"market", config.key().as_ref(), &market.id], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(init, payer = owner, space = 8 + Order::INIT_SPACE,
        seeds = [b"order", market.key().as_ref(), owner.key().as_ref(), &terms.salt], bump)]
    pub order: Account<'info, Order>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    #[account(seeds = [b"vault", market.key().as_ref(), &[0]], bump,
        constraint = base_vault.mint == market.mints[0] @ ProtocolError::InvalidAsset,
        constraint = base_vault.owner == market.key() @ ProtocolError::InvalidAccount)]
    pub base_vault: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,
    #[account(seeds = [b"vault", market.key().as_ref(), &[1]], bump,
        constraint = quote_vault.mint == market.mints[1] @ ProtocolError::InvalidAsset,
        constraint = quote_vault.owner == market.key() @ ProtocolError::InvalidAccount)]
    pub quote_vault: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,
}

/// Wire order of remaining accounts: four (claim mint, claim vault) pairs in asset
/// order 2..6, one order per plan leg, then unique (wallet, trader) PDA pairs per participant.
/// Load each wallet once, aggregate self-trades/recipient aliases, and serialize once.
pub fn place<'info>(
    ctx: Context<'info, Place<'info>>,
    terms: OrderTerms,
    plan: Plan,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let market_key = ctx.accounts.market.key();
    let owner_key = ctx.accounts.owner.key();
    let config = &ctx.accounts.config;
    let market = &mut ctx.accounts.market;
    require!(
        terms.branch < 2
            && terms.side < 2
            && terms.funding < 2
            && terms.tif < 2
            && terms.max_fee_bps <= rules::MAX_FEE_BPS
            && terms.recipient != Pubkey::default(),
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
    let wallet_start = 8 + plan.legs.len();
    require!(
        plan.legs.len() <= MAX_MAKERS && ctx.remaining_accounts.len() >= wallet_start + 2,
        ProtocolError::InvalidTerms
    );
    require!(
        (ctx.remaining_accounts.len() - wallet_start).is_multiple_of(2)
            && ctx.remaining_accounts.len() <= wallet_start + 4 * (plan.legs.len() + 1),
        ProtocolError::InvalidTerms
    );

    // No duplicate mutable account is accepted anywhere in this instruction's tail.
    let mut keys = BTreeSet::new();
    for (index, info) in ctx.remaining_accounts.iter().enumerate() {
        let trader = index >= wallet_start && (index - wallet_start) % 2 == 1;
        require!(
            (trader || info.is_writable) && keys.insert(*info.key),
            ProtocolError::InvalidAccount
        );
        require_keys_neq!(
            *info.key,
            ctx.accounts.order.key(),
            ProtocolError::InvalidAccount
        );
        require_keys_neq!(*info.key, market_key, ProtocolError::InvalidAccount);
    }
    let mut before = [ClaimSnapshot::default(); 4];
    for (i, snapshot) in before.iter_mut().enumerate() {
        *snapshot = invariants::read_claim(
            market,
            &market_key,
            i + 2,
            &ctx.remaining_accounts[i * 2],
            &ctx.remaining_accounts[i * 2 + 1],
        )?;
    }
    let underlying = [
        ctx.accounts.base_vault.amount,
        ctx.accounts.quote_vault.amount,
    ];
    for collateral in 0..2 {
        invariants::check_collateral(
            market,
            collateral,
            underlying[collateral],
            [before[collateral * 2], before[collateral * 2 + 1]],
        )?;
    }

    let mut wallets = BTreeMap::<Pubkey, Wallet>::new();
    let mut nonces = BTreeMap::<Pubkey, u64>::new();
    for pair in ctx.remaining_accounts[wallet_start..].chunks_exact(2) {
        let info = &pair[0];
        require_keys_eq!(*info.owner, crate::ID, ProtocolError::InvalidAccount);
        let wallet = Wallet::try_deserialize(&mut info.try_borrow_data()?.as_ref())?;
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
        nonces.insert(wallet.owner, trader.minimum_nonce);
        require!(
            wallets.insert(wallet.owner, wallet).is_none(),
            ProtocolError::InvalidAccount
        );
    }
    checked(rules::valid_nonce(terms.nonce, nonce(&nonces, &owner_key)?))?;
    wallet(&mut wallets, &terms.recipient)?;
    let notional = checked(
        market
            .terms
            .caps()
            .validate_order(terms.quantity, terms.price),
    )?;

    let mut makers = Vec::with_capacity(plan.legs.len());
    let mut total = 0u64;
    for (i, leg) in plan.legs.iter().enumerate() {
        let info = &ctx.remaining_accounts[8 + i];
        require_keys_eq!(*info.owner, crate::ID, ProtocolError::InvalidAccount);
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
        require!(
            order.status == 1
                && order.remaining == leg.expected_remaining
                && leg.quantity > 0
                && leg.quantity <= order.remaining
                && order.terms.tif == 0
                && order.terms.branch == terms.branch
                && order.terms.side != terms.side
                && order.sequence < plan.next_sequence,
            ProtocolError::StalePlan
        );
        checked(rules::valid_expiry(
            now,
            order.terms.expiry,
            market.terms.trading_cutoff,
        ))?;
        checked(rules::valid_nonce(
            order.terms.nonce,
            nonce(&nonces, &order.owner)?,
        ))?;
        wallet(&mut wallets, &order.terms.recipient)?;
        require!(
            config.maker_bps <= order.terms.max_fee_bps && config.taker_bps <= terms.max_fee_bps,
            ProtocolError::FeeCap
        );
        total = add(total, leg.quantity)?;
        makers.push(order);
    }
    require!(total <= terms.quantity, ProtocolError::InvalidTerms);
    let asset = terms.asset();
    let reserved = if terms.side == 0 {
        notional
    } else {
        terms.quantity
    };
    market.debit(wallet(&mut wallets, &owner_key)?, asset, reserved)?;
    market.escrow[asset] = market.escrow[asset]
        .checked_add(reserved as u128)
        .ok_or(error!(ProtocolError::Arithmetic))?;
    market.open_notional = market
        .open_notional
        .checked_add(notional as u128)
        .ok_or(error!(ProtocolError::Arithmetic))?;
    let owner_wallet = wallet(&mut wallets, &owner_key)?;
    owner_wallet.open_notional = owner_wallet
        .open_notional
        .checked_add(notional as u128)
        .ok_or(error!(ProtocolError::Arithmetic))?;
    let taker = &mut ctx.accounts.order;
    taker.market = market_key;
    taker.owner = owner_key;
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
        .ok_or(error!(ProtocolError::Arithmetic))?;
    taker.terms = terms;

    let mut expected_minted = [0u64; 4];
    for (i, (maker, leg)) in makers.iter_mut().zip(&plan.legs).enumerate() {
        let taker_is_buy = taker.terms.side == 0;
        let taker_key = taker.key();
        let price = maker.terms.price;
        let (buy, sell): (&mut Order, &mut Order) = if taker_is_buy {
            (&mut *taker, maker)
        } else {
            (maker, &mut *taker)
        };
        let fill = checked(rules::fill(
            leg.quantity,
            market.terms.step,
            buy.remaining,
            sell.remaining,
            buy.terms.price,
            sell.terms.price,
            !taker_is_buy,
        ))?;
        let (buyer_fee, buyer_carry) = checked(rules::fee(
            leg.quantity,
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
            .ok_or(error!(ProtocolError::Insolvent))?;
        market.escrow[sell.terms.asset()] = market.escrow[sell.terms.asset()]
            .checked_sub(leg.quantity as u128)
            .ok_or(error!(ProtocolError::Insolvent))?;
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
        for (collateral, funding, amount) in [
            (0, sell.terms.funding, leg.quantity),
            (1, buy.terms.funding, fill.quote),
        ] {
            if funding == 0 {
                for branch in 0..2 {
                    let index = collateral * 2 + branch;
                    expected_minted[index] = add(expected_minted[index], amount)?;
                }
            }
        }
        let authority = market.to_account_info();
        settle_asset(
            market,
            authority.clone(),
            ctx.remaining_accounts,
            &mut wallets,
            0,
            sell.terms.funding,
            &sell.owner,
            &buy.terms.recipient,
            buy.terms.branch,
            leg.quantity,
            buyer_fee,
        )?;
        settle_asset(
            market,
            authority,
            ctx.remaining_accounts,
            &mut wallets,
            1,
            buy.terms.funding,
            &buy.owner,
            &sell.terms.recipient,
            buy.terms.branch,
            fill.quote,
            seller_fee,
        )?;
        buy.remaining = fill.buyer_remaining;
        buy.filled = add(buy.filled, leg.quantity)?;
        buy.reserved = fill.buyer_reserved;
        buy.open_notional = sub(buy.open_notional, fill.buyer_notional_reduction)?;
        sell.remaining = fill.seller_remaining;
        sell.filled = add(sell.filled, leg.quantity)?;
        sell.reserved = sub(sell.reserved, leg.quantity)?;
        sell.open_notional = sub(sell.open_notional, fill.seller_notional_reduction)?;
        if buy.remaining == 0 {
            buy.status = 2;
        }
        if sell.remaining == 0 {
            sell.status = 2;
        }
        emit!(Trade {
            market: market_key,
            taker: taker_key,
            maker: *ctx.remaining_accounts[8 + i].key,
            branch: buy.terms.branch,
            quantity: leg.quantity,
            price,
            quote: fill.quote,
            buyer_fee,
            seller_fee
        });
    }
    if taker.terms.tif == 1 && taker.remaining != 0 {
        release(market, taker, wallet(&mut wallets, &owner_key)?)?;
    }
    checked(market.terms.caps().final_exposure(
        wallet(&mut wallets, &owner_key)?.open_notional,
        market.open_notional,
    ))?;
    let mut after = [ClaimSnapshot::default(); 4];
    for (i, snapshot) in after.iter_mut().enumerate() {
        *snapshot = invariants::read_claim(
            market,
            &market_key,
            i + 2,
            &ctx.remaining_accounts[i * 2],
            &ctx.remaining_accounts[i * 2 + 1],
        )?;
        invariants::check_delta(before[i], *snapshot, expected_minted[i], true)?;
    }
    for collateral in 0..2 {
        invariants::check_collateral(
            market,
            collateral,
            underlying[collateral],
            [after[collateral * 2], after[collateral * 2 + 1]],
        )?;
    }
    // Serialization happens only after every leg and final cap check succeeds.
    // Solana rolls back token CPIs as well as state on every instruction/transaction error.
    for (i, maker) in makers.iter().enumerate() {
        maker.try_serialize(
            &mut ctx.remaining_accounts[8 + i]
                .try_borrow_mut_data()?
                .as_mut(),
        )?;
    }
    for pair in ctx.remaining_accounts[wallet_start..].chunks_exact(2) {
        let info = &pair[0];
        let original = Wallet::try_deserialize(&mut info.try_borrow_data()?.as_ref())?;
        wallet(&mut wallets, &original.owner)?
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

fn wallet<'a>(wallets: &'a mut BTreeMap<Pubkey, Wallet>, owner: &Pubkey) -> Result<&'a mut Wallet> {
    wallets
        .get_mut(owner)
        .ok_or(error!(ProtocolError::InvalidAccount))
}

fn nonce(nonces: &BTreeMap<Pubkey, u64>, owner: &Pubkey) -> Result<u64> {
    nonces
        .get(owner)
        .copied()
        .ok_or(error!(ProtocolError::InvalidAccount))
}

#[allow(clippy::too_many_arguments)]
fn settle_asset<'info>(
    market: &mut Market,
    authority: AccountInfo<'info>,
    accounts: &[AccountInfo<'info>],
    wallets: &mut BTreeMap<Pubkey, Wallet>,
    collateral: usize,
    funding: u8,
    funder: &Pubkey,
    recipient: &Pubkey,
    branch: u8,
    amount: u64,
    fee: u64,
) -> Result<()> {
    let active = 2 + collateral * 2 + branch as usize;
    let inactive = 2 + collateral * 2 + (1 - branch) as usize;
    if funding == 0 {
        market.backing[collateral] = add(market.backing[collateral], amount)?;
        for asset in [active, inactive] {
            mint_claim(
                market,
                authority.clone(),
                accounts[(asset - 2) * 2].clone(),
                accounts[(asset - 2) * 2 + 1].clone(),
                amount,
            )?;
        }
        market.credit(wallet(wallets, funder)?, inactive, amount)?;
    }
    market.credit(wallet(wallets, recipient)?, active, sub(amount, fee)?)?;
    market.fees[active - 2] = add(market.fees[active - 2], fee)?;
    Ok(())
}
