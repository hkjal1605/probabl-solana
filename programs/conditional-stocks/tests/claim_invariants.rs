use anchor_lang::{
    prelude::*,
    solana_program::{program_option::COption, program_pack::Pack},
};
use anchor_spl::token::{
    self,
    spl_token::state::{Account as RawAccount, AccountState, Mint as RawMint},
};
use conditional_stocks::{
    invariants::{check_collateral, check_delta, read_claim, ClaimSnapshot},
    state::Market,
    ID,
};

fn market() -> Market {
    let data = vec![0; 8 + Market::INIT_SPACE];
    let mut market = Market::try_deserialize_unchecked(&mut data.as_slice()).unwrap();
    market.state = protocol_core::OPEN;
    market.decimals = [6, 9];
    market.backing = [100, 100];
    market.credits = [10, 10, 20, 20, 20, 20];
    market.escrow = [20, 20, 20, 20, 20, 20];
    market.fees = [1; 4];
    market
}

#[test]
fn global_supply_checks_do_not_confuse_external_claims_with_vault_balances() {
    for collateral in 0..2 {
        let mut m = market();
        let claims = [ClaimSnapshot {
            supply: 100,
            balance: 60,
        }; 2];
        for state in [1, 2, 3, 4] {
            m.state = state;
            check_collateral(&m, collateral, 130, claims).unwrap();
        }
        // Old recorded-liability reconciliation passes 129 == 10+20+99,
        // but the actual externally held claim supply still requires 100.
        m.backing[collateral] = 99;
        assert!(check_collateral(&m, collateral, 129, claims).is_err());
        m.backing[collateral] = 100;
        assert!(check_collateral(&m, collateral, 129, claims).is_err());
        let mut shortage = claims;
        shortage[0].balance = 40; // credits + escrow + fees = 41
        assert!(check_collateral(&m, collateral, 130, shortage).is_err());
        shortage[0] = ClaimSnapshot {
            supply: 59,
            balance: 60,
        };
        assert!(check_collateral(&m, collateral, 130, shortage).is_err());
        // Unsolicited custody and externally burned claims are safe surplus.
        check_collateral(
            &m,
            collateral,
            1_000,
            [ClaimSnapshot {
                supply: 60,
                balance: 60,
            }; 2],
        )
        .unwrap();
        for state in [6, 7] {
            m.state = state;
            m.payouts = [1, 0];
            let no_surplus = [
                claims[0],
                ClaimSnapshot {
                    supply: u64::MAX,
                    balance: 60,
                },
            ];
            check_collateral(&m, collateral, 130, no_surplus).unwrap();
            m.payouts = [0, 1];
            assert!(check_collateral(&m, collateral, 130, no_surplus).is_err());
            m.payouts = [1, 1];
            let odd = [
                claims[0],
                ClaimSnapshot {
                    supply: 101,
                    balance: 60,
                },
            ];
            assert!(check_collateral(&m, collateral, 130, odd).is_err());
            m.backing[collateral] = 101;
            check_collateral(&m, collateral, 131, odd).unwrap();
            m.backing[collateral] = 100;
            m.payouts = [0, 0];
            assert!(check_collateral(&m, collateral, 130, claims).is_err());
        }
        m.state = 5;
        assert!(check_collateral(&m, collateral, 130, claims).is_err());
        assert!(check_collateral(&m, 2, 130, claims).is_err());
    }
}

#[test]
fn deltas_check_both_supply_and_actual_vault_amount_with_overflow_rejection() {
    for minting in [false, true] {
        for amount in [0, 1, 60] {
            let before = ClaimSnapshot {
                supply: 100,
                balance: 60,
            };
            let after = if minting {
                ClaimSnapshot {
                    supply: 100 + amount,
                    balance: 60 + amount,
                }
            } else {
                ClaimSnapshot {
                    supply: 100 - amount,
                    balance: 60 - amount,
                }
            };
            check_delta(before, after, amount, minting).unwrap();
            assert!(check_delta(
                before,
                ClaimSnapshot {
                    supply: after.supply + 1,
                    ..after
                },
                amount,
                minting
            )
            .is_err());
            assert!(check_delta(
                before,
                ClaimSnapshot {
                    balance: after.balance + 1,
                    ..after
                },
                amount,
                minting
            )
            .is_err());
        }
    }
    let zero = ClaimSnapshot::default();
    let maximum = ClaimSnapshot {
        supply: u64::MAX,
        balance: u64::MAX,
    };
    assert!(check_delta(maximum, zero, 1, true).is_err());
    assert!(check_delta(zero, maximum, 1, false).is_err());
    check_delta(zero, maximum, u64::MAX, true).unwrap();
    check_delta(maximum, zero, u64::MAX, false).unwrap();
}

#[test]
fn claim_snapshots_validate_identity_authority_and_reload_actual_data() {
    for case in 0..17 {
        let mut m = market();
        let market_key = Pubkey::new_unique();
        let mut mint_key =
            Pubkey::find_program_address(&[b"claim", market_key.as_ref(), &[2]], &ID).0;
        let mut vault_key =
            Pubkey::find_program_address(&[b"vault", market_key.as_ref(), &[2]], &ID).0;
        m.mints[2] = mint_key;
        let mut mint_owner = token::ID;
        let mut vault_owner = token::ID;
        let mut mint = RawMint {
            mint_authority: COption::Some(market_key),
            supply: 100,
            decimals: 6,
            is_initialized: true,
            freeze_authority: COption::None,
        };
        let mut vault = RawAccount {
            mint: mint_key,
            owner: market_key,
            amount: 60,
            state: AccountState::Initialized,
            ..RawAccount::default()
        };
        match case {
            1 => mint_owner = Pubkey::new_unique(),
            2 => vault_owner = Pubkey::new_unique(),
            3 => mint_key = Pubkey::new_unique(),
            4 => vault_key = Pubkey::new_unique(),
            5 => m.mints[2] = Pubkey::new_unique(),
            6 => mint.mint_authority = COption::Some(Pubkey::new_unique()),
            7 => mint.freeze_authority = COption::Some(market_key),
            8 => mint.decimals = 9,
            9 => vault.mint = Pubkey::new_unique(),
            10 => vault.owner = Pubkey::new_unique(),
            11 => vault.state = AccountState::Frozen,
            12 => vault.delegate = COption::Some(market_key),
            13 => vault.close_authority = COption::Some(market_key),
            14 => mint.supply = 59,
            15 => mint.is_initialized = false,
            16 => vault.state = AccountState::Uninitialized,
            _ => {}
        }
        let mut mint_data = vec![0; RawMint::LEN];
        let mut vault_data = vec![0; RawAccount::LEN];
        RawMint::pack(mint, &mut mint_data).unwrap();
        RawAccount::pack(vault, &mut vault_data).unwrap();
        let mut mint_lamports = 1;
        let mut vault_lamports = 1;
        let mint_info = AccountInfo::new(
            &mint_key,
            false,
            true,
            &mut mint_lamports,
            &mut mint_data,
            &mint_owner,
            false,
        );
        let vault_info = AccountInfo::new(
            &vault_key,
            false,
            true,
            &mut vault_lamports,
            &mut vault_data,
            &vault_owner,
            false,
        );
        let actual = read_claim(&m, &market_key, 2, &mint_info, &vault_info);
        assert_eq!(actual.is_ok(), case == 0, "case {case}: {actual:?}");
        if case == 0 {
            assert_eq!(
                actual.unwrap(),
                ClaimSnapshot {
                    supply: 100,
                    balance: 60
                }
            );
            assert!(read_claim(&m, &market_key, 6, &mint_info, &vault_info).is_err());
            let borrow = mint_info.try_borrow_mut_data().unwrap();
            assert!(read_claim(&m, &market_key, 2, &mint_info, &vault_info).is_err());
            drop(borrow);
            // Equivalent to a CPI changing supply/balance after an Anchor load.
            mint.supply = 101;
            vault.amount = 61;
            RawMint::pack(mint, &mut mint_info.try_borrow_mut_data().unwrap()).unwrap();
            RawAccount::pack(vault, &mut vault_info.try_borrow_mut_data().unwrap()).unwrap();
            assert_eq!(
                read_claim(&m, &market_key, 2, &mint_info, &vault_info).unwrap(),
                ClaimSnapshot {
                    supply: 101,
                    balance: 61
                }
            );
        }
    }
}
