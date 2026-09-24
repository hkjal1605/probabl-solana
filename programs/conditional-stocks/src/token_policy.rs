//! Collateral is accounted in raw, public, spendable token units. Never treat
//! withheld fees as backing, or accept an extension merely because it decodes.
//!
//! Two admission tiers:
//! - Generic extensions (fees, metadata, grouping) are accepted for any mint.
//! - Issuer controls used by regulated tokenized-stock issuers are accepted only
//!   for a pool whose market administrator explicitly admitted that category
//!   (`AssetPool::admitted`). Their runtime state is re-read on every custody or
//!   exposure path: a configured transfer hook, a paused mint or a UI multiplier
//!   outside its dividend band fails closed instead of being bypassed.
use crate::state::ProtocolError;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{
        pausable::PausableConfig, scaled_ui_amount::ScaledUiAmountConfig,
        transfer_hook::TransferHook, BaseStateWithExtensions, ExtensionType, StateWithExtensions,
    },
    state::Mint,
};

/// The issuer can move or burn tokens from any account, including pool vaults.
/// Admission is an explicit trust decision in that issuer; a seizure makes the
/// pool fail its solvency checks rather than silently diluting other mints.
pub const PERMANENT_DELEGATE: u16 = 1 << 0;
/// The issuer can halt all transfers. Custody transfers and new exposure are
/// rejected while paused; internal claim accounting remains recoverable.
pub const PAUSABLE: u16 = 1 << 1;
/// New token accounts (including pool vaults) may start frozen until the issuer
/// thaws them. Frozen vaults cannot be listed or traded.
pub const DEFAULT_ACCOUNT_STATE: u16 = 1 << 2;
/// UI scaling for dividends and corporate actions. Raw units are unchanged; the
/// unified book converts share units at the live multiplier and halts a leg
/// whose multiplier leaves the dividend band (a split or reverse split).
pub const SCALED_UI_AMOUNT: u16 = 1 << 3;
/// Accepted only while the hook program is unset. No hook CPI is performed.
pub const TRANSFER_HOOK: u16 = 1 << 4;
/// Mint-level confidential configuration only. Protocol vaults never enable
/// confidential balances, so custody remains public and exact. Covers
/// `ConfidentialTransferFeeConfig` too, which Token-2022 requires on a mint
/// combining confidential transfers with a transfer fee (PreStocks): it governs
/// only fees withheld from confidential balances, which vaults never hold.
pub const CONFIDENTIAL_TRANSFER: u16 = 1 << 5;
pub const ISSUER_CONTROLS: u16 = PERMANENT_DELEGATE
    | PAUSABLE
    | DEFAULT_ACCOUNT_STATE
    | SCALED_UI_AMOUNT
    | TRANSFER_HOOK
    | CONFIDENTIAL_TRANSFER;

/// Generic extensions accepted without issuer admission.
pub fn allowed_extension(extension: ExtensionType) -> bool {
    matches!(
        extension,
        ExtensionType::TransferFeeConfig
            | ExtensionType::MetadataPointer
            | ExtensionType::TokenMetadata
            | ExtensionType::GroupPointer
            | ExtensionType::TokenGroup
            | ExtensionType::GroupMemberPointer
            | ExtensionType::TokenGroupMember
    )
}

/// The admission category of an issuer-control extension, if it is one.
pub fn issuer_control(extension: ExtensionType) -> Option<u16> {
    match extension {
        ExtensionType::PermanentDelegate => Some(PERMANENT_DELEGATE),
        ExtensionType::Pausable => Some(PAUSABLE),
        ExtensionType::DefaultAccountState => Some(DEFAULT_ACCOUNT_STATE),
        ExtensionType::ScaledUiAmount => Some(SCALED_UI_AMOUNT),
        ExtensionType::TransferHook => Some(TRANSFER_HOOK),
        ExtensionType::ConfidentialTransferMint | ExtensionType::ConfidentialTransferFeeConfig => {
            Some(CONFIDENTIAL_TRANSFER)
        }
        _ => None,
    }
}

/// Fresh runtime view of an admitted mint.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MintState {
    /// Issuer-control categories present on the mint.
    pub controls: u16,
    pub paused: bool,
    /// Effective ScaledUiAmount multiplier at `now` as f64 bits; 1.0 if absent.
    pub multiplier: u64,
}

impl Default for MintState {
    fn default() -> Self {
        Self {
            controls: 0,
            paused: false,
            multiplier: protocol_core::UNIT_MULTIPLIER,
        }
    }
}

impl MintState {
    /// Custody paths: the token program itself enforces pause and hooks; these
    /// explicit checks give an actionable error before any CPI.
    pub fn transferable(&self) -> Result<()> {
        require!(!self.paused, ProtocolError::IssuerPaused);
        Ok(())
    }
}

/// Classify and bound every extension. Unknown/future types and every category
/// outside `admitted` fail closed. Hooks must be unset whenever inspected.
pub fn inspect(info: &AccountInfo, admitted: u16, now: i64) -> Result<MintState> {
    if info.owner == &anchor_spl::token::ID {
        return Ok(MintState::default()); // The InterfaceAccount caller also validates initialized Mint data.
    }
    require_keys_eq!(
        *info.owner,
        anchor_spl::token_2022::ID,
        ProtocolError::InvalidAccount
    );
    let data = info.try_borrow_data()?;
    let mint = StateWithExtensions::<Mint>::unpack(&data)?;
    let mut state = MintState::default();
    for extension in mint
        .get_extension_types()
        .map_err(|_| error!(ProtocolError::UnsupportedTokenExtension))?
    {
        if allowed_extension(extension) {
            continue;
        }
        let control = issuer_control(extension)
            .ok_or_else(|| error!(ProtocolError::UnsupportedTokenExtension))?;
        require!(
            admitted & control == control,
            ProtocolError::UnsupportedTokenExtension
        );
        state.controls |= control;
    }
    if state.controls & TRANSFER_HOOK != 0 {
        let hook = mint
            .get_extension::<TransferHook>()
            .map_err(|_| error!(ProtocolError::UnsupportedTokenExtension))?;
        require!(
            Option::<Pubkey>::from(hook.program_id).is_none(),
            ProtocolError::TransferHookEnabled
        );
    }
    if state.controls & PAUSABLE != 0 {
        let pausable = mint
            .get_extension::<PausableConfig>()
            .map_err(|_| error!(ProtocolError::UnsupportedTokenExtension))?;
        state.paused = bool::from(pausable.paused);
    }
    if state.controls & SCALED_UI_AMOUNT != 0 {
        let scaled = mint
            .get_extension::<ScaledUiAmountConfig>()
            .map_err(|_| error!(ProtocolError::UnsupportedTokenExtension))?;
        // Token-2022 applies `new_multiplier` from its timestamp onward.
        let effective = if now >= i64::from(scaled.new_multiplier_effective_timestamp) {
            scaled.new_multiplier.0
        } else {
            scaled.multiplier.0
        };
        state.multiplier = u64::from_le_bytes(effective);
        require!(
            protocol_core::multiplier_parts(state.multiplier).is_ok(),
            ProtocolError::UnsupportedTokenExtension
        );
    }
    Ok(state)
}

/// Generic-tier admission, used for the deployment quote and protocol claims.
pub fn validate_mint(info: &AccountInfo) -> Result<()> {
    inspect(info, 0, 0).map(|_| ())
}

/// Admitted-tier admission for a pool's mint, with its pause state.
pub fn validate_admitted(info: &AccountInfo, admitted: u16) -> Result<MintState> {
    require!(
        admitted & !ISSUER_CONTROLS == 0,
        ProtocolError::UnsupportedTokenExtension
    );
    inspect(info, admitted, Clock::get()?.unix_timestamp)
}
