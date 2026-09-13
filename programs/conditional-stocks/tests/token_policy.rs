use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_spl::token_2022::spl_token_2022::{extension::ExtensionType, state::Mint};
use conditional_stocks::token_policy::{allowed_extension, validate_mint};

fn mint_data(extension: Option<u16>) -> Vec<u8> {
    let mut data = vec![0; if extension.is_some() { 234 } else { Mint::LEN }];
    Mint::pack(
        Mint {
            is_initialized: true,
            ..Mint::default()
        },
        &mut data[..Mint::LEN],
    )
    .unwrap();
    if let Some(extension) = extension {
        data[165] = 1; // AccountType::Mint, after the base/padding region.
        data[166..168].copy_from_slice(&extension.to_le_bytes());
        data[168..170].copy_from_slice(&64u16.to_le_bytes());
    }
    data
}

#[test]
fn mint_account_validation_and_malformed_data_fail_closed() {
    let key = Pubkey::new_unique();
    for (owner, mut data, accepted) in [
        (anchor_spl::token::ID, mint_data(None), true),
        (anchor_spl::token_2022::ID, mint_data(None), true),
        (anchor_spl::token_2022::ID, mint_data(Some(18)), true),
        (anchor_spl::token_2022::ID, mint_data(Some(12)), false),
        (anchor_spl::token_2022::ID, mint_data(Some(60_000)), false),
        (anchor_spl::token_2022::ID, vec![0; 81], false),
        (anchor_spl::token_2022::ID, vec![0; Mint::LEN], false),
        (Pubkey::new_unique(), mint_data(None), false),
    ] {
        let mut lamports = 1;
        let account = AccountInfo::new(&key, false, false, &mut lamports, &mut data, &owner, false);
        assert_eq!(validate_mint(&account).is_ok(), accepted);
        if owner == anchor_spl::token_2022::ID {
            let _borrow = account.try_borrow_mut_data().unwrap();
            assert!(validate_mint(&account).is_err());
        }
    }
}

#[test]
fn extension_policy_is_exhaustive_and_fail_closed() {
    // Every known production extension in the pinned interface, including
    // account-only types, must have an explicit expected policy decision.
    for id in 0u16..=27 {
        let extension = ExtensionType::try_from(id).unwrap();
        let expected = matches!(id, 1 | 18 | 19 | 20 | 21 | 22 | 23);
        assert_eq!(allowed_extension(extension), expected, "{extension:?}");
    }
    assert!(ExtensionType::try_from(28u16).is_err());
    assert!(ExtensionType::try_from(u16::MAX).is_err());
}
