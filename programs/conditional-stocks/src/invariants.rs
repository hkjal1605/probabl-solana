//! Independent runtime checks over fresh token-account data, not cached Anchor
//! fields or recorded credit/backing changes. Donations/burns may leave surplus.
use crate::state::*;
use anchor_lang::{prelude::*, solana_program::program_option::COption};
use anchor_spl::token::{self, Mint, TokenAccount};
use protocol_core as rules;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ClaimSnapshot {
    pub supply: u64,
    pub balance: u64,
}

/// This function deliberately re-deserializes AccountInfo on *every* call,
/// including after CPI. Account<Mint>.supply without reload would be stale.
pub fn read_claim(
    market: &Market,
    market_key: &Pubkey,
    asset: usize,
    mint_info: &AccountInfo,
    vault_info: &AccountInfo,
) -> Result<ClaimSnapshot> {
    require!((2..6).contains(&asset), ProtocolError::InvalidAsset);
    let (expected_vault, _) =
        Pubkey::find_program_address(&[b"vault", market_key.as_ref(), &[asset as u8]], &crate::ID);
    require_keys_eq!(
        *vault_info.key,
        expected_vault,
        ProtocolError::InvalidAccount
    );
    read_claim_with_validated_vault(market, market_key, asset, mint_info, vault_info)
}

/// Positions' typed Anchor constraints have already checked this vault PDA.
/// Exchange's untyped tail must enter through read_claim instead.
pub(crate) fn read_claim_with_validated_vault(
    market: &Market,
    market_key: &Pubkey,
    asset: usize,
    mint_info: &AccountInfo,
    vault_info: &AccountInfo,
) -> Result<ClaimSnapshot> {
    require!((2..6).contains(&asset), ProtocolError::InvalidAsset);
    require_keys_eq!(*mint_info.owner, token::ID, ProtocolError::InvalidAccount);
    require_keys_eq!(*vault_info.owner, token::ID, ProtocolError::InvalidAccount);
    // initialize_claim registers only the canonical mint; Market is a validated
    // program-owned PDA. Its immutable mint identity needs no second bump search.
    require_keys_eq!(
        *mint_info.key,
        market.mints[asset],
        ProtocolError::InvalidAsset
    );
    let mint = Mint::try_deserialize(&mut mint_info.try_borrow_data()?.as_ref())?;
    let vault = TokenAccount::try_deserialize(&mut vault_info.try_borrow_data()?.as_ref())?;
    require!(
        mint.is_initialized
            && mint.mint_authority == COption::Some(*market_key)
            && mint.freeze_authority.is_none()
            && mint.decimals == market.decimals[(asset - 2) / 2],
        ProtocolError::InvalidAccount
    );
    require_keys_eq!(vault.mint, *mint_info.key, ProtocolError::InvalidAsset);
    require_keys_eq!(vault.owner, *market_key, ProtocolError::InvalidAccount);
    require!(
        vault.state == token::spl_token::state::AccountState::Initialized
            && vault.delegate.is_none()
            && vault.close_authority.is_none(),
        ProtocolError::InvalidAccount
    );
    require!(mint.supply >= vault.amount, ProtocolError::ClaimBacking);
    Ok(ClaimSnapshot {
        supply: mint.supply,
        balance: vault.amount,
    })
}

/// Fresh data after our classic-SPL mint/burn CPI, for accounts whose identity
/// and authority were already checked by read_claim in this same instruction.
/// Not an entrypoint validator: never use this on an unvalidated account pair.
pub(crate) fn reload_claim(
    mint_info: &AccountInfo,
    vault_info: &AccountInfo,
) -> Result<ClaimSnapshot> {
    let mint = Mint::try_deserialize(&mut mint_info.try_borrow_data()?.as_ref())?;
    let vault = TokenAccount::try_deserialize(&mut vault_info.try_borrow_data()?.as_ref())?;
    require!(mint.supply >= vault.amount, ProtocolError::ClaimBacking);
    Ok(ClaimSnapshot {
        supply: mint.supply,
        balance: vault.amount,
    })
}

pub fn check_collateral(
    market: &Market,
    collateral: usize,
    underlying_balance: u64,
    claims: [ClaimSnapshot; 2],
) -> Result<()> {
    require!(collateral < 2, ProtocolError::InvalidAsset);
    let payouts = match market.state {
        rules::REDEEMABLE | rules::ARCHIVED => Some((market.payouts[0], market.payouts[1])),
        rules::SCHEDULED | rules::OPEN | rules::FROZEN | rules::AWAITING => None,
        _ => return err!(ProtocolError::InvalidState),
    };
    let required = checked(rules::claim_backing(
        claims[0].supply,
        claims[1].supply,
        payouts,
    ))?;
    require!(
        market.backing[collateral] >= required,
        ProtocolError::ClaimBacking
    );
    require!(
        underlying_balance as u128 >= market.liability(collateral)?,
        ProtocolError::Insolvent
    );
    for (branch, claim) in claims.iter().enumerate() {
        require!(claim.supply >= claim.balance, ProtocolError::ClaimBacking);
        require!(
            claim.balance as u128 >= market.liability(2 + 2 * collateral + branch)?,
            ProtocolError::Insolvent
        );
    }
    Ok(())
}

/// Mint/burn amounts are determined by the requested operation or validated fill,
/// independently of the resulting supply and accounting fields.
pub fn check_delta(
    before: ClaimSnapshot,
    after: ClaimSnapshot,
    amount: u64,
    minting: bool,
) -> Result<()> {
    let expected = if minting {
        (
            before.supply.checked_add(amount),
            before.balance.checked_add(amount),
        )
    } else {
        (
            before.supply.checked_sub(amount),
            before.balance.checked_sub(amount),
        )
    };
    require!(
        expected == (Some(after.supply), Some(after.balance)),
        ProtocolError::TokenDelta
    );
    Ok(())
}
