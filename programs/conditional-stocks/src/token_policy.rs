//! Collateral is accounted in raw, public, spendable token units. Never treat
//! withheld fees as backing, or accept an extension merely because it decodes.
use crate::state::ProtocolError;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
    state::Mint,
};

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

pub fn validate_mint(info: &AccountInfo) -> Result<()> {
    if info.owner == &anchor_spl::token::ID {
        return Ok(()); // The InterfaceAccount caller also validates initialized Mint data.
    }
    require_keys_eq!(
        *info.owner,
        anchor_spl::token_2022::ID,
        ProtocolError::InvalidAccount
    );
    let data = info.try_borrow_data()?;
    let mint = StateWithExtensions::<Mint>::unpack(&data)?;
    for extension in mint
        .get_extension_types()
        .map_err(|_| error!(ProtocolError::UnsupportedTokenExtension))?
    {
        require!(
            allowed_extension(extension),
            ProtocolError::UnsupportedTokenExtension
        );
    }
    Ok(())
}
