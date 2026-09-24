//! Host tests of the issuer-token admission policy over REAL Token-2022 mint
//! account data: synthetic replicas built with the pinned `spl_token_2022`
//! interface and the raw mainnet bytes of NVDAx, NVDAon, NVDAr and SPCX.
//!
//! `validate_admitted` reads `Clock::get()`, which has no host sysvar, so the
//! admitted tier is exercised through `inspect(info, admitted, now)` directly.
#[path = "support/issuer_mint.rs"]
mod issuer_mint;

use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
    state::{AccountState, Mint},
};
use conditional_stocks::state::ProtocolError;
use conditional_stocks::token_policy::{
    allowed_extension, inspect, issuer_control, validate_mint, MintState, CONFIDENTIAL_TRANSFER,
    DEFAULT_ACCOUNT_STATE, ISSUER_CONTROLS, PAUSABLE, PERMANENT_DELEGATE, SCALED_UI_AMOUNT,
    TRANSFER_HOOK,
};
use issuer_mint::*;
use protocol_core::UNIT_MULTIPLIER;

/// A time after every mainnet ScaledUiAmount timestamp in the fixtures.
const NOW: i64 = 1_790_000_000;
const NVDAX_OLD: f64 = 1.0009180758490996;
const NVDAX_NEW: f64 = 1.001701196801074;
const NVDAON_M: f64 = 1.0017152487959897;

fn run(data: &[u8], owner: Pubkey, admitted: u16, now: i64) -> Result<MintState> {
    let key = Pubkey::new_unique();
    let mut data = data.to_vec();
    let mut lamports = 1_000_000_000;
    let info = AccountInfo::new(&key, false, false, &mut lamports, &mut data, &owner, false);
    inspect(&info, admitted, now)
}
fn check(data: &[u8], admitted: u16, now: i64) -> Result<MintState> {
    run(data, anchor_spl::token_2022::ID, admitted, now)
}
fn generic(data: &[u8]) -> Result<()> {
    let key = Pubkey::new_unique();
    let owner = anchor_spl::token_2022::ID;
    let mut data = data.to_vec();
    let mut lamports = 1_000_000_000;
    let info = AccountInfo::new(&key, false, false, &mut lamports, &mut data, &owner, false);
    validate_mint(&info)
}
fn err(code: ProtocolError) -> anchor_lang::error::Error {
    code.into()
}
fn types(data: &[u8]) -> Vec<ExtensionType> {
    StateWithExtensions::<Mint>::unpack(data)
        .unwrap()
        .get_extension_types()
        .unwrap()
}
fn state(controls: u16, paused: bool, multiplier: f64) -> MintState {
    MintState {
        controls,
        paused,
        multiplier: multiplier.to_bits(),
    }
}

// ---------- raw mainnet bytes ----------

#[test]
fn mainnet_issuer_mints_are_admitted_exactly_at_their_controls() {
    for (address, decimals, controls, multiplier) in [
        (NVDAX, 8, 63, NVDAX_NEW),
        (NVDAON, 9, 62, NVDAON_M),
        (NVDAR, 9, 47, 1.0),
        (SPCX, 6, 63, 1.0),
        // PreStocks: every control, a 5-for-1 split already applied to SpaceX.
        (PRESTOCKS_OPENAI, 9, 63, 1.4861347),
        (PRESTOCKS_SPACEX, 9, 63, 5.0),
    ] {
        let data = mainnet(address);
        let mint = StateWithExtensions::<Mint>::unpack(&data).unwrap();
        assert_eq!(mint.base.decimals, decimals, "{address}");
        assert!(mint.base.is_initialized);
        // Generic tier (quote/claims) rejects every issuer-control mint.
        assert_eq!(
            generic(&data),
            Err(err(ProtocolError::UnsupportedTokenExtension))
        );
        assert_eq!(
            check(&data, 0, NOW),
            Err(err(ProtocolError::UnsupportedTokenExtension))
        );
        // Exactly its controls: accepted and reported.
        let admitted = check(&data, controls, NOW).unwrap();
        assert_eq!(admitted.controls, controls, "{address}");
        assert!(!admitted.paused, "{address}");
        assert_eq!(admitted.multiplier, multiplier.to_bits(), "{address}");
        assert!(protocol_core::multiplier_parts(admitted.multiplier).is_ok());
        // Removing any single present category rejects.
        for bit in 0..6 {
            let control = 1u16 << bit;
            if controls & control != 0 {
                assert_eq!(
                    check(&data, controls & !control, NOW),
                    Err(err(ProtocolError::UnsupportedTokenExtension)),
                    "{address} without {control}"
                );
            }
        }
        // A superset is tolerated by `inspect` (initialize_pool requires equality)
        // and still reports only the categories the mint uses.
        assert_eq!(
            check(&data, ISSUER_CONTROLS, NOW).unwrap().controls,
            controls
        );
        // Every issuer-control extension maps to exactly the reported mask.
        let mask = types(&data)
            .into_iter()
            .filter_map(issuer_control)
            .fold(0, |m, c| m | c);
        assert_eq!(mask, controls);
    }
    // NVDAx: the old multiplier applies before its announced timestamp.
    let nvdax = mainnet(NVDAX);
    assert_eq!(
        check(&nvdax, 63, 1_789_000_199).unwrap().multiplier,
        NVDAX_OLD.to_bits()
    );
    assert_eq!(
        check(&nvdax, 63, 1_789_000_200).unwrap().multiplier,
        NVDAX_NEW.to_bits()
    );
}

#[test]
fn replicas_are_byte_identical_to_mainnet_extension_data() {
    for (address, issuer) in [(NVDAX, nvdax()), (NVDAON, nvdaon()), (NVDAR, nvdar())] {
        let real = mainnet(address);
        let replica = issuer.build();
        assert_eq!(replica.len(), real.len(), "{address} length");
        assert_eq!(types(&replica), types(&real), "{address} extension order");
        // Extension TLVs (after the base mint and account type) are identical;
        // the base differs only in supply, which moves with issuance.
        assert_eq!(&replica[165..], &real[165..], "{address} TLV bytes");
        let (a, b) = (
            StateWithExtensions::<Mint>::unpack(&replica).unwrap().base,
            StateWithExtensions::<Mint>::unpack(&real).unwrap().base,
        );
        assert_eq!(
            (
                a.mint_authority,
                a.decimals,
                a.is_initialized,
                a.freeze_authority
            ),
            (
                b.mint_authority,
                b.decimals,
                b.is_initialized,
                b.freeze_authority
            )
        );
    }
}

// ---------- synthetic replicas ----------

#[test]
fn replicas_report_controls_and_generic_tier_rejects_them() {
    for (issuer, controls, multiplier) in [
        (nvdax(), 63, NVDAX_NEW),
        (nvdaon(), 62, NVDAON_M),
        (nvdar(), 47, 1.0),
    ] {
        let data = issuer.build();
        assert_eq!(
            generic(&data),
            Err(err(ProtocolError::UnsupportedTokenExtension))
        );
        assert_eq!(
            check(&data, 0, NOW),
            Err(err(ProtocolError::UnsupportedTokenExtension))
        );
        assert_eq!(
            check(&data, controls, NOW),
            Ok(state(controls, false, multiplier))
        );
        for control in [
            PERMANENT_DELEGATE,
            PAUSABLE,
            DEFAULT_ACCOUNT_STATE,
            SCALED_UI_AMOUNT,
            TRANSFER_HOOK,
            CONFIDENTIAL_TRANSFER,
        ] {
            let result = check(&data, controls & !control, NOW);
            if controls & control != 0 {
                assert_eq!(result, Err(err(ProtocolError::UnsupportedTokenExtension)));
            } else {
                assert_eq!(result, Ok(state(controls, false, multiplier)));
            }
        }
    }
    // Controls are mask bits in declaration order.
    assert_eq!(
        [
            PERMANENT_DELEGATE,
            PAUSABLE,
            DEFAULT_ACCOUNT_STATE,
            SCALED_UI_AMOUNT,
            TRANSFER_HOOK,
            CONFIDENTIAL_TRANSFER
        ],
        [1, 2, 4, 8, 16, 32]
    );
    assert_eq!(ISSUER_CONTROLS, 63);
}

#[test]
fn each_issuer_control_alone_needs_exactly_its_bit() {
    let base = |ext: Ext| Issuer {
        decimals: 9,
        mint_authority: Some(Pubkey::new_unique()),
        supply: 1_000,
        freeze_authority: None,
        extensions: vec![ext],
    };
    let authority = Some(Pubkey::new_unique());
    for (ext, control) in [
        (
            Ext::PermanentDelegate(Pubkey::new_unique()),
            PERMANENT_DELEGATE,
        ),
        (
            Ext::Pausable {
                authority,
                paused: false,
            },
            PAUSABLE,
        ),
        (
            Ext::DefaultAccountState(AccountState::Initialized),
            DEFAULT_ACCOUNT_STATE,
        ),
        (
            Ext::ScaledUiAmount {
                authority,
                multiplier: 1.5f64.to_bits(),
                timestamp: 0,
                new_multiplier: 1.5f64.to_bits(),
            },
            SCALED_UI_AMOUNT,
        ),
        (
            Ext::TransferHook {
                authority,
                program_id: None,
            },
            TRANSFER_HOOK,
        ),
        (
            Ext::ConfidentialTransferMint {
                authority,
                auto_approve: false,
            },
            CONFIDENTIAL_TRANSFER,
        ),
    ] {
        let data = base(ext).build();
        let multiplier = if control == SCALED_UI_AMOUNT {
            1.5
        } else {
            1.0
        };
        assert_eq!(
            check(&data, control, NOW),
            Ok(state(control, false, multiplier))
        );
        assert_eq!(
            check(&data, ISSUER_CONTROLS & !control, NOW),
            Err(err(ProtocolError::UnsupportedTokenExtension))
        );
        assert_eq!(
            check(&data, 0, NOW),
            Err(err(ProtocolError::UnsupportedTokenExtension))
        );
    }
    // A frozen default account state is still an admissible mint: pool vault
    // freezing is enforced at listing/trading time (LegHalted), not here.
    let frozen = base(Ext::DefaultAccountState(AccountState::Frozen)).build();
    assert_eq!(
        check(&frozen, DEFAULT_ACCOUNT_STATE, NOW),
        Ok(state(DEFAULT_ACCOUNT_STATE, false, 1.0))
    );
    let frozen_nvdax = nvdax().default_state(AccountState::Frozen).build();
    assert_eq!(
        check(&frozen_nvdax, 63, NOW),
        Ok(state(63, false, NVDAX_NEW))
    );
    // No extensions at all: generic and default state.
    let plain = Issuer {
        decimals: 6,
        mint_authority: None,
        supply: 5,
        freeze_authority: None,
        extensions: vec![],
    }
    .build();
    assert_eq!(check(&plain, 0, NOW), Ok(MintState::default()));
    assert_eq!(generic(&plain), Ok(()));
    assert_eq!(MintState::default().multiplier, UNIT_MULTIPLIER);
}

#[test]
fn pause_state_is_reported_and_blocks_custody() {
    for (issuer, controls) in [(nvdax(), 63), (nvdaon(), 62), (nvdar(), 47)] {
        let paused = issuer.clone().paused(true).build();
        let observed = check(&paused, controls, NOW).unwrap();
        assert!(observed.paused);
        assert_eq!(observed.controls, controls);
        assert_eq!(
            observed.transferable(),
            Err(err(ProtocolError::IssuerPaused))
        );
        let live = check(&issuer.paused(false).build(), controls, NOW).unwrap();
        assert!(!live.paused);
        assert_eq!(live.transferable(), Ok(()));
    }
}

#[test]
fn a_configured_transfer_hook_fails_closed() {
    let program = Some(Pubkey::new_unique());
    for (issuer, controls) in [(nvdax(), 63), (nvdaon(), 62)] {
        let hooked = issuer.hook(program).build();
        assert_eq!(
            check(&hooked, controls, NOW),
            Err(err(ProtocolError::TransferHookEnabled))
        );
        // Even with every control admitted, and at any time.
        assert_eq!(
            check(&hooked, ISSUER_CONTROLS, 0),
            Err(err(ProtocolError::TransferHookEnabled))
        );
        // Without the admission bit, the category itself is rejected first.
        assert_eq!(
            check(&hooked, controls & !TRANSFER_HOOK, NOW),
            Err(err(ProtocolError::UnsupportedTokenExtension))
        );
    }
    // NVDAr has no hook extension: adding one needs the TRANSFER_HOOK bit.
    let hooked = nvdar()
        .with(Ext::TransferHook {
            authority: None,
            program_id: None,
        })
        .build();
    assert_eq!(
        check(&hooked, 47, NOW),
        Err(err(ProtocolError::UnsupportedTokenExtension))
    );
    assert_eq!(check(&hooked, 63, NOW), Ok(state(63, false, 1.0)));
}

#[test]
fn effective_multiplier_follows_the_token_2022_timestamp_rule() {
    let (old, new) = (1.25f64.to_bits(), 1.5f64.to_bits());
    let data = nvdax().scaled(old, 1_000, new).build();
    for (now, expected) in [
        (i64::MIN, old),
        (0, old),
        (999, old),
        (1_000, new),
        (1_001, new),
        (i64::MAX, new),
    ] {
        assert_eq!(check(&data, 63, now).unwrap().multiplier, expected, "{now}");
    }
    // A negative timestamp is already effective at 0.
    let data = nvdar().scaled(old, -5, new).build();
    assert_eq!(check(&data, 47, 0).unwrap().multiplier, new);
    assert_eq!(check(&data, 47, -6).unwrap().multiplier, old);
    // Only the effective value is decoded: a garbage pending/retired value is ignored.
    let data = nvdar().scaled(f64::NAN.to_bits(), 10, new).build();
    assert_eq!(check(&data, 47, 10).unwrap().multiplier, new);
    assert_eq!(
        check(&data, 47, 9),
        Err(err(ProtocolError::UnsupportedTokenExtension))
    );
}

#[test]
fn invalid_effective_multipliers_are_rejected() {
    for bad in [
        0u64,
        (-0.0f64).to_bits(),
        (-1.0f64).to_bits(),
        (-NVDAX_NEW).to_bits(),
        f64::NAN.to_bits(),
        f64::INFINITY.to_bits(),
        f64::NEG_INFINITY.to_bits(),
        1,                           // subnormal
        f64::MIN_POSITIVE.to_bits(), // normal but below 2^-11
        2f64.powi(53).to_bits(),     // above 2^53
        f64::MAX.to_bits(),
    ] {
        for (issuer, controls) in [(nvdax(), 63u16), (nvdaon(), 62), (nvdar(), 47)] {
            let data = issuer.scaled(bad, 0, bad).build();
            assert_eq!(
                check(&data, controls, NOW),
                Err(err(ProtocolError::UnsupportedTokenExtension)),
                "{bad:#x}"
            );
        }
    }
    // Boundaries of the admissible range are accepted.
    for good in [2f64.powi(-11), 2f64.powi(53) - 1.0, 0.8, 2.0, 10.0] {
        let data = nvdar().scaled(good.to_bits(), 0, good.to_bits()).build();
        assert_eq!(check(&data, 47, NOW).unwrap().multiplier, good.to_bits());
    }
}

#[test]
fn unsupported_extensions_reject_even_with_every_control_admitted() {
    for kind in [
        ExtensionType::NonTransferable,
        ExtensionType::InterestBearingConfig,
        ExtensionType::ConfidentialMintBurn,
        ExtensionType::MintCloseAuthority,
    ] {
        assert!(!allowed_extension(kind) && issuer_control(kind).is_none());
        for (issuer, controls) in [(nvdax(), 63u16), (nvdaon(), 62), (nvdar(), 47)] {
            let data = issuer.with(Ext::Other(kind)).build();
            assert!(types(&data).contains(&kind));
            for admitted in [controls, ISSUER_CONTROLS, u16::MAX] {
                assert_eq!(
                    check(&data, admitted, NOW),
                    Err(err(ProtocolError::UnsupportedTokenExtension)),
                    "{kind:?} admitted {admitted}"
                );
            }
        }
    }
    // Generic extensions stay accepted without admission, alone or with issuer controls.
    for kind in [
        ExtensionType::TransferFeeConfig,
        ExtensionType::GroupPointer,
    ] {
        let data = nvdax().with(Ext::Other(kind)).build();
        assert_eq!(check(&data, 63, NOW), Ok(state(63, false, NVDAX_NEW)));
        let alone = Issuer {
            decimals: 6,
            mint_authority: None,
            supply: 0,
            freeze_authority: None,
            extensions: vec![Ext::Other(kind)],
        }
        .build();
        assert_eq!(generic(&alone), Ok(()));
    }
}

#[test]
fn issuer_control_mapping_is_exhaustive() {
    for id in 0u16..=27 {
        let kind = ExtensionType::try_from(id).unwrap();
        let expected = match kind {
            ExtensionType::PermanentDelegate => Some(PERMANENT_DELEGATE),
            ExtensionType::Pausable => Some(PAUSABLE),
            ExtensionType::DefaultAccountState => Some(DEFAULT_ACCOUNT_STATE),
            ExtensionType::ScaledUiAmount => Some(SCALED_UI_AMOUNT),
            ExtensionType::TransferHook => Some(TRANSFER_HOOK),
            ExtensionType::ConfidentialTransferMint
            | ExtensionType::ConfidentialTransferFeeConfig => Some(CONFIDENTIAL_TRANSFER),
            _ => None,
        };
        assert_eq!(issuer_control(kind), expected, "{kind:?}");
        // No extension is both generic and an issuer control.
        assert!(!(allowed_extension(kind) && expected.is_some()));
    }
}

#[test]
fn owner_and_data_are_validated_before_extensions() {
    let data = nvdax().build();
    // Classic SPL Token mints have no extensions: default state, any admission.
    assert_eq!(
        run(&data, anchor_spl::token::ID, 0, NOW),
        Ok(MintState::default())
    );
    // Any other owner is rejected.
    assert_eq!(
        run(&data, Pubkey::new_unique(), 63, NOW),
        Err(err(ProtocolError::InvalidAccount))
    );
    // Truncated or uninitialized data fails closed.
    assert!(check(&data[..100], 63, NOW).is_err());
    let mut uninitialized = data.clone();
    uninitialized[45] = 0; // is_initialized
    assert!(check(&uninitialized, 63, NOW).is_err());
    // A mint whose account-type byte says Account is rejected.
    let mut wrong_type = data.clone();
    wrong_type[165] = 2;
    assert!(check(&wrong_type, 63, NOW).is_err());
}

#[test]
fn prestocks_confidential_fee_config_is_part_of_the_confidential_transfer_control() {
    let data = mainnet(PRESTOCKS_OPENAI);
    let kinds = types(&data);
    assert!(kinds.contains(&ExtensionType::ConfidentialTransferFeeConfig));
    assert!(kinds.contains(&ExtensionType::TransferFeeConfig));
    // Without the confidential-transfer admission the fee config alone rejects.
    assert_eq!(
        check(&data, ISSUER_CONTROLS & !CONFIDENTIAL_TRANSFER, NOW),
        Err(err(ProtocolError::UnsupportedTokenExtension))
    );
    assert_eq!(check(&data, ISSUER_CONTROLS, NOW).unwrap().controls, 63);
}

#[test]
fn tessera_mints_are_generic_fee_tokens() {
    let data = mainnet(TESSERA_OPENAI);
    let mint = StateWithExtensions::<Mint>::unpack(&data).unwrap();
    assert_eq!(mint.base.decimals, 9);
    assert_eq!(
        types(&data),
        vec![
            ExtensionType::TransferFeeConfig,
            ExtensionType::MetadataPointer,
            ExtensionType::TokenMetadata
        ]
    );
    // No issuer controls: accepted on the generic tier and at admission 0.
    assert_eq!(generic(&data), Ok(()));
    assert_eq!(check(&data, 0, NOW), Ok(state(0, false, 1.0)));
}
