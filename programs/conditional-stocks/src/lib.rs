#![allow(ambiguous_glob_reexports)]
use anchor_lang::prelude::*;

declare_id!("8S7LwM6yRszZaAoEQqgE1AYcZJLpyVVC5MRr7vqCxLtg");

pub mod custody;
pub mod delegation;
pub mod exchange;
pub mod governance;
pub mod invariants;
pub mod maintenance;
pub mod pool;
pub mod state;
pub mod token_policy;

pub use custody::*;
pub use delegation::*;
pub use exchange::*;
pub use governance::*;
pub use maintenance::*;
pub use pool::*;
pub use state::*;

#[program]
pub mod conditional_stocks {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, roles: Roles) -> Result<()> {
        governance::initialize(ctx, roles)
    }
    pub fn configure(
        ctx: Context<Configure>,
        roles: Roles,
        maker_bps: u16,
        taker_bps: u16,
    ) -> Result<()> {
        governance::configure(ctx, roles, maker_bps, taker_bps)
    }
    pub fn propose_admin(ctx: Context<Configure>, successor: Pubkey) -> Result<()> {
        governance::propose_admin(ctx, successor)
    }
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        governance::accept_admin(ctx)
    }
    pub fn pause(ctx: Context<Pause>, paused: bool, reason: [u8; 32]) -> Result<()> {
        governance::pause(ctx, paused, reason)
    }
    pub fn create_market(ctx: Context<CreateMarket>, id: [u8; 32], terms: Terms) -> Result<()> {
        governance::create_market(ctx, id, terms)
    }
    pub fn lifecycle(ctx: Context<Lifecycle>, action: u8, commitment: [u8; 32]) -> Result<()> {
        governance::lifecycle(ctx, action, commitment)
    }
    pub fn resolve(
        ctx: Context<Lifecycle>,
        yes: u8,
        no: u8,
        evidence: [u8; 32],
        uri: String,
    ) -> Result<()> {
        governance::resolve(ctx, yes, no, evidence, uri)
    }
    pub fn initialize_asset(ctx: Context<InitializeAsset>, asset: u8) -> Result<()> {
        custody::initialize_asset(ctx, asset)
    }
    pub fn initialize_pool(ctx: Context<InitializePool>) -> Result<()> {
        pool::initialize_pool(ctx)
    }
    pub fn initialize_credit(ctx: Context<InitializeCredit>) -> Result<()> {
        pool::initialize_credit(ctx)
    }
    pub fn deposit_pool(
        ctx: Context<PoolTransfer>,
        amount: u64,
        minimum_credit: u64,
    ) -> Result<()> {
        pool::deposit_pool(ctx, amount, minimum_credit)
    }
    pub fn withdraw_pool(
        ctx: Context<PoolTransfer>,
        amount: u64,
        minimum_received: u64,
    ) -> Result<()> {
        pool::withdraw_pool(ctx, amount, minimum_received)
    }
    pub fn initialize_claim(ctx: Context<InitializeClaim>, asset: u8) -> Result<()> {
        custody::initialize_claim(ctx, asset)
    }
    pub fn initialize_wallet(ctx: Context<InitializeWallet>) -> Result<()> {
        custody::initialize_wallet(ctx)
    }
    pub fn deposit(ctx: Context<Deposit>, asset: u8, amount: u64) -> Result<()> {
        custody::deposit(ctx, asset, amount)
    }
    pub fn withdraw(ctx: Context<Withdraw>, asset: u8, amount: u64) -> Result<()> {
        custody::withdraw(ctx, asset, amount)
    }
    pub fn deposit_bounded(
        ctx: Context<Deposit>,
        asset: u8,
        amount: u64,
        minimum_credit: u64,
    ) -> Result<()> {
        custody::deposit_bounded(ctx, asset, amount, minimum_credit)
    }
    pub fn withdraw_bounded(
        ctx: Context<Withdraw>,
        asset: u8,
        amount: u64,
        minimum_received: u64,
    ) -> Result<()> {
        custody::withdraw_bounded(ctx, asset, amount, minimum_received)
    }
    pub fn split(ctx: Context<Positions>, collateral: u8, amount: u64) -> Result<()> {
        custody::split(ctx, collateral, amount)
    }
    pub fn merge(ctx: Context<Positions>, collateral: u8, amount: u64) -> Result<()> {
        custody::merge(ctx, collateral, amount)
    }
    pub fn redeem(
        ctx: Context<Positions>,
        collateral: u8,
        yes_amount: u64,
        no_amount: u64,
    ) -> Result<()> {
        custody::redeem(ctx, collateral, yes_amount, no_amount)
    }
    pub fn transfer_credit(ctx: Context<TransferCredit>, asset: u8, amount: u64) -> Result<()> {
        custody::transfer_credit(ctx, asset, amount)
    }
    pub fn claim_fees(ctx: Context<ClaimFees>, asset: u8, amount: u64) -> Result<()> {
        custody::claim_fees(ctx, asset, amount)
    }
    pub fn invalidate_nonce(ctx: Context<InvalidateNonce>, minimum: u64) -> Result<()> {
        exchange::invalidate_nonce(ctx, minimum)
    }
    pub fn approve_delegate(ctx: Context<ApproveDelegate>, limits: DelegateLimits) -> Result<()> {
        delegation::approve_delegate(ctx, limits)
    }
    pub fn revoke_delegate(ctx: Context<RevokeDelegate>) -> Result<()> {
        delegation::revoke_delegate(ctx)
    }
    pub fn revoke_all_delegates(ctx: Context<RevokeAllDelegates>) -> Result<()> {
        delegation::revoke_all_delegates(ctx)
    }
    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        exchange::cancel(ctx)
    }
    pub fn retire_orders<'info>(
        ctx: Context<'info, RetireOrders<'info>>,
        order_count: u8,
    ) -> Result<()> {
        maintenance::retire_orders(ctx, order_count)
    }
    pub fn compact_market(ctx: Context<CompactMarket>) -> Result<()> {
        maintenance::compact_market(ctx)
    }
    pub fn cancel_orders<'info>(
        ctx: Context<'info, RetireOrders<'info>>,
        order_count: u8,
    ) -> Result<()> {
        maintenance::cancel_orders(ctx, order_count)
    }
    pub fn place<'info>(
        ctx: Context<'info, Place<'info>>,
        terms: OrderTerms,
        plan: Plan,
        participants: u8,
        delegations: u8,
    ) -> Result<()> {
        exchange::place(ctx, terms, plan, participants, delegations)
    }
}
