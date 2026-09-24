//! Fault injection against the actual compiled SBF program, never a host mock.
//! Run after anchor build with BPF_OUT_DIR=$PWD/target/deploy cargo test
//! --test sbf_hardening --offline -- --ignored (a disposable in-process bank).
#![allow(deprecated)]
use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program_option::COption,
        program_pack::Pack,
    },
    InstructionData, ToAccountMetas,
};
use anchor_spl::token::{
    self,
    spl_token::state::{Account as RawAccount, AccountState, Mint as RawMint},
};
use conditional_stocks::pool::{pool_address, pool_vault, AssetCredit, AssetPool};
use conditional_stocks::{
    accounts, instruction,
    state::{
        claim, underlying, BaseLeg, Config, Market, OrderTerms, Plan, Roles, Terms, Trader, Wallet,
        ASSETS, QUOTE,
    },
    ID,
};

/// The single listed base leg. Assets 0..6 cover the quote (0 underlying,
/// 1/2 claims) and this leg (3 underlying, 4/5 claims).
const BASE: usize = 1;
const LISTED: usize = 6;
use solana_program_test::ProgramTest;
use solana_sdk::{
    account::{Account as BankAccount, AccountSharedData},
    signature::{Keypair, Signer},
    transaction::Transaction,
};

fn serialized<T: AccountSerialize>(state: &T) -> BankAccount {
    let mut data = Vec::new();
    state.try_serialize(&mut data).unwrap();
    BankAccount {
        data,
        owner: ID,
        lamports: 100_000_000,
        ..BankAccount::default()
    }
}
fn token_data<T: Pack>(state: T) -> BankAccount {
    let mut data = vec![0; T::LEN];
    T::pack(state, &mut data).unwrap();
    BankAccount {
        data,
        owner: token::ID,
        lamports: 100_000_000,
        ..BankAccount::default()
    }
}

#[tokio::test]
#[ignore = "Requires a current compiled artifact; set BPF_OUT_DIR=target/deploy and run with --ignored"]
async fn sbf_rejects_unbacked_external_supply_and_custody_shortfalls_before_every_position_path() {
    assert!(
        std::env::var("BPF_OUT_DIR").is_ok(),
        "Compile the contract and set BPF_OUT_DIR"
    );
    let user = Keypair::new();
    let owner = user.pubkey();
    let (config_key, config_bump) = Pubkey::find_program_address(&[b"config", owner.as_ref()], &ID);
    let id = [77; 32];
    let (market_key, market_bump) =
        Pubkey::find_program_address(&[b"market", config_key.as_ref(), &id], &ID);
    let (wallet_key, wallet_bump) =
        Pubkey::find_program_address(&[b"wallet", market_key.as_ref(), owner.as_ref()], &ID);
    let (trader_key, trader_bump) =
        Pubkey::find_program_address(&[b"trader", config_key.as_ref(), owner.as_ref()], &ID);
    let mut vaults: Vec<_> = (0..LISTED as u8)
        .map(|a| Pubkey::find_program_address(&[b"vault", market_key.as_ref(), &[a]], &ID).0)
        .collect();
    let mut mints = vec![Pubkey::default(); ASSETS];
    for (i, mint) in mints.iter_mut().enumerate().take(LISTED) {
        *mint = if i % 3 == 0 {
            Pubkey::new_unique()
        } else {
            Pubkey::find_program_address(&[b"claim", market_key.as_ref(), &[i as u8]], &ID).0
        };
    }
    // Indexed by collateral: quote pool, base-leg pool.
    let pools = [
        pool_address(&config_key, &mints[underlying(QUOTE)]),
        pool_address(&config_key, &mints[underlying(BASE)]),
    ];
    let credits = pools.map(|p| {
        Pubkey::find_program_address(&[b"asset-credit", p.as_ref(), owner.as_ref()], &ID).0
    });
    vaults[underlying(QUOTE)] = pool_vault(&pools[QUOTE]);
    vaults[underlying(BASE)] = pool_vault(&pools[BASE]);
    let pool_bumps = [QUOTE, BASE].map(|c| {
        Pubkey::find_program_address(
            &[b"pool", config_key.as_ref(), mints[underlying(c)].as_ref()],
            &ID,
        )
        .1
    });
    let roles = Roles {
        market_admin: owner,
        guardian: owner,
        resolution_admin: owner,
    };
    let config = Config {
        seed_authority: owner,
        admin: owner,
        quote_mint: mints[underlying(QUOTE)],
        roles,
        paused: false,
        maker_bps: 0,
        taker_bps: 0,
        pending_admin: Pubkey::default(),
        admin_after: 0,
        bump: config_bump,
    };
    let zero = vec![0; 8 + Market::INIT_SPACE];
    let mut market = Market::try_deserialize_unchecked(&mut zero.as_slice()).unwrap();
    market.ledgers();
    market.config = config_key;
    market.id = id;
    market.bump = market_bump;
    market.mints = mints.clone();
    market.bases = 1;
    market.legs[0] = BaseLeg {
        scale: 1,
        multiplier: protocol_core::UNIT_MULTIPLIER,
        active: true,
    };
    market.decimals = [6; 4];
    market.pool_bumps[..2].copy_from_slice(&pool_bumps);
    market.vaults_initialized = (1 << LISTED) - 1;
    market.state = protocol_core::OPEN;
    for asset in 0..LISTED {
        market.credits[asset] = if asset % 3 == 0 { 0 } else { 100 };
    }
    market.backing[QUOTE] = 100;
    market.backing[BASE] = 100;
    market.terms = Terms {
        condition: [1; 32],
        yes_index: 1,
        no_index: 2,
        rules_hash: [2; 32],
        metadata_hash: [3; 32],
        metadata_uri: String::new(),
        trading_open: 0,
        trading_cutoff: i64::MAX,
        share_decimals: 6,
        tick: protocol_core::WAD,
        step: 1,
        min_notional: 1,
        max_quantity: 1_000,
        max_order: 1_000,
        max_wallet: 2_000,
        max_market: 4_000,
    };
    let wallet = Wallet {
        market: market_key,
        owner,
        balances: [0, 100, 100, 0, 100, 100, 0, 0, 0, 0, 0, 0],
        open_notional: 0,
        bump: wallet_bump,
    };
    let trader = Trader {
        config: config_key,
        owner,
        minimum_nonce: 0,
        delegation_epoch: 0,
        bump: trader_bump,
    };
    let mut baseline = vec![
        (config_key, serialized(&config)),
        (market_key, serialized(&market)),
        (wallet_key, serialized(&wallet)),
        (trader_key, serialized(&trader)),
    ];
    for collateral in [QUOTE, BASE] {
        baseline.push((
            pools[collateral],
            serialized(&AssetPool {
                config: config_key,
                mint: mints[underlying(collateral)],
                token_program: token::ID,
                decimals: 6,
                liability: 200,
                bump: pool_bumps[collateral],
                admitted: 0,
                vault_bump: Pubkey::find_program_address(
                    &[b"pool-vault", pools[collateral].as_ref()],
                    &ID,
                )
                .1,
            }),
        ));
        baseline.push((
            credits[collateral],
            serialized(&AssetCredit {
                pool: pools[collateral],
                owner,
                available: 100,
                bump: Pubkey::find_program_address(
                    &[b"asset-credit", pools[collateral].as_ref(), owner.as_ref()],
                    &ID,
                )
                .1,
            }),
        ));
    }
    for asset in 0..LISTED {
        let custody = asset % 3 == 0;
        baseline.push((
            mints[asset],
            token_data(RawMint {
                mint_authority: COption::Some(if custody { owner } else { market_key }),
                supply: if custody { 200 } else { 100 },
                decimals: 6,
                is_initialized: true,
                freeze_authority: COption::None,
            }),
        ));
        baseline.push((
            vaults[asset],
            token_data(RawAccount {
                mint: mints[asset],
                owner: if custody {
                    pools[asset / 3]
                } else {
                    market_key
                },
                amount: if custody { 200 } else { 100 },
                state: AccountState::Initialized,
                ..RawAccount::default()
            }),
        ));
    }
    let mut program = ProgramTest::new("conditional_stocks", ID, None);
    program.prefer_bpf(true);
    program.add_account(
        owner,
        BankAccount {
            lamports: 10_000_000_000,
            ..BankAccount::default()
        },
    );
    for (key, account) in &baseline {
        program.add_account(*key, account.clone());
    }
    let mut context = program.start_with_context().await;
    let (yes, no) = (claim(BASE, 0), claim(BASE, 1));
    let position_accounts = accounts::Positions {
        owner,
        market: market_key,
        wallet: wallet_key,
        yes_mint: mints[yes],
        no_mint: mints[no],
        yes_vault: vaults[yes],
        no_vault: vaults[no],
        token_program: token::ID,
        underlying_vault: vaults[underlying(BASE)],
        underlying_mint: mints[underlying(BASE)],
        pool: pools[BASE],
        credit: credits[BASE],
    }
    .to_account_metas(None);
    for fault in 0..2 {
        for path in 0..4 {
            for (key, account) in &baseline {
                context.set_account(key, &AccountSharedData::from(account.clone()));
            }
            if path == 2 {
                market.state = protocol_core::REDEEMABLE;
                market.payouts = [1, 1];
                context.set_account(&market_key, &AccountSharedData::from(serialized(&market)));
            }
            let (target, mut bad) = if fault == 0 {
                (
                    mints[no],
                    baseline
                        .iter()
                        .find(|(k, _)| *k == mints[no])
                        .unwrap()
                        .1
                        .clone(),
                )
            } else {
                (
                    vaults[underlying(BASE)],
                    baseline
                        .iter()
                        .find(|(k, _)| *k == vaults[underlying(BASE)])
                        .unwrap()
                        .1
                        .clone(),
                )
            };
            if fault == 0 {
                let mut mint = RawMint::unpack(&bad.data).unwrap();
                mint.supply = 101;
                RawMint::pack(mint, &mut bad.data).unwrap();
            } else {
                let mut vault = RawAccount::unpack(&bad.data).unwrap();
                vault.amount = 199;
                RawAccount::pack(vault, &mut bad.data).unwrap();
            }
            context.set_account(&target, &AccountSharedData::from(bad));
            let mut before = Vec::new();
            for (key, _) in &baseline {
                before.push(
                    context
                        .banks_client
                        .get_account(*key)
                        .await
                        .unwrap()
                        .unwrap()
                        .data,
                );
            }
            let salt = [10 + fault * 4 + path; 32];
            let order = Pubkey::find_program_address(
                &[b"order", market_key.as_ref(), owner.as_ref(), &salt],
                &ID,
            )
            .0;
            let ix = if path < 3 {
                Instruction {
                    program_id: ID,
                    accounts: position_accounts.clone(),
                    data: match path {
                        0 => instruction::Split {
                            collateral: BASE as u8,
                            amount: 1,
                        }
                        .data(),
                        1 => instruction::Merge {
                            collateral: BASE as u8,
                            amount: 1,
                        }
                        .data(),
                        _ => instruction::Redeem {
                            collateral: BASE as u8,
                            yes_amount: 2,
                            no_amount: 0,
                        }
                        .data(),
                    },
                }
            } else {
                let mut accounts = accounts::Place {
                    authority: owner,
                    delegation: None,
                    owner,
                    config: config_key,
                    market: market_key,
                    order,
                    token_program: token::ID,
                    system_program: anchor_lang::system_program::ID,
                    quote_vault: vaults[underlying(QUOTE)],
                    quote_pool: pools[QUOTE],
                }
                .to_account_metas(None);
                // Quote claims, then the touched leg: pool, pool vault, issuer
                // mint (read-only), then its claim mints and vaults.
                for asset in [claim(QUOTE, 0), claim(QUOTE, 1)] {
                    accounts.push(AccountMeta::new(mints[asset], false));
                    accounts.push(AccountMeta::new(vaults[asset], false));
                }
                accounts.push(AccountMeta::new_readonly(pools[BASE], false));
                accounts.push(AccountMeta::new_readonly(vaults[underlying(BASE)], false));
                accounts.push(AccountMeta::new_readonly(mints[underlying(BASE)], false));
                for asset in [yes, no] {
                    accounts.push(AccountMeta::new(mints[asset], false));
                    accounts.push(AccountMeta::new(vaults[asset], false));
                }
                accounts.push(AccountMeta::new(wallet_key, false));
                accounts.push(AccountMeta::new_readonly(trader_key, false));
                accounts.push(AccountMeta::new(credits[BASE], false));
                Instruction {
                    program_id: ID,
                    accounts,
                    data: instruction::Place {
                        delegations: 0,
                        participants: 1,
                        touched: 1,
                        terms: OrderTerms {
                            recipient: owner,
                            salt,
                            quantity: 1,
                            price: protocol_core::WAD,
                            expiry: i64::MAX - 1,
                            nonce: 0,
                            max_fee_bps: 0,
                            branch: 0,
                            side: 1,
                            funding: 0,
                            tif: 0,
                            bases: 1,
                        },
                        plan: Plan {
                            deadline: i64::MAX - 2,
                            next_sequence: 0,
                            min_fill: 0,
                            maker_bps: 0,
                            taker_bps: 0,
                            legs: vec![],
                        },
                    }
                    .data(),
                }
            };
            let blockhash = context.get_new_latest_blockhash().await.unwrap();
            let tx = Transaction::new_signed_with_payer(&[ix], Some(&owner), &[&user], blockhash);
            let error = context
                .banks_client
                .process_transaction(tx)
                .await
                .unwrap_err();
            let code = if fault == 0 { 6016 } else { 6007 };
            assert!(
                format!("{error:?}").contains(&format!("Custom({code})")),
                "fault {fault}, path {path}: {error:?}"
            );
            for ((key, _), original) in baseline.iter().zip(before) {
                assert_eq!(
                    context
                        .banks_client
                        .get_account(*key)
                        .await
                        .unwrap()
                        .unwrap()
                        .data,
                    original
                );
            }
            if path == 3 {
                assert!(context
                    .banks_client
                    .get_account(order)
                    .await
                    .unwrap()
                    .is_none());
            }
        }
    }
    // Healthy positive control proves the exact same SBF/CPI environment works.
    for (key, account) in &baseline {
        context.set_account(key, &AccountSharedData::from(account.clone()));
    }
    for data in [
        instruction::Split {
            collateral: BASE as u8,
            amount: 1,
        }
        .data(),
        instruction::Merge {
            collateral: BASE as u8,
            amount: 1,
        }
        .data(),
    ] {
        let blockhash = context.get_new_latest_blockhash().await.unwrap();
        let tx = Transaction::new_signed_with_payer(
            &[Instruction {
                program_id: ID,
                accounts: position_accounts.clone(),
                data,
            }],
            Some(&owner),
            &[&user],
            blockhash,
        );
        context.banks_client.process_transaction(tx).await.unwrap();
    }
    for (key, original) in &baseline {
        assert_eq!(
            context
                .banks_client
                .get_account(*key)
                .await
                .unwrap()
                .unwrap()
                .data,
            original.data
        );
    }
}
