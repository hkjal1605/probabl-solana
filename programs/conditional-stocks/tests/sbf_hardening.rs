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
    state::{Config, Market, OrderTerms, Plan, Roles, Terms, Trader, Wallet},
    ID,
};
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
    let mut vaults: Vec<_> = (0..6)
        .map(|a| Pubkey::find_program_address(&[b"vault", market_key.as_ref(), &[a]], &ID).0)
        .collect();
    let mut mints = [Pubkey::new_unique(); 6];
    mints[1] = Pubkey::new_unique();
    let pools = [
        pool_address(&config_key, &mints[0]),
        pool_address(&config_key, &mints[1]),
    ];
    let credits = pools.map(|p| {
        Pubkey::find_program_address(&[b"asset-credit", p.as_ref(), owner.as_ref()], &ID).0
    });
    vaults[0] = pool_vault(&pools[0]);
    vaults[1] = pool_vault(&pools[1]);
    for (i, mint) in mints.iter_mut().enumerate().skip(2) {
        *mint = Pubkey::find_program_address(&[b"claim", market_key.as_ref(), &[i as u8]], &ID).0;
    }
    let roles = Roles {
        market_admin: owner,
        guardian: owner,
        resolution_admin: owner,
    };
    let config = Config {
        seed_authority: owner,
        admin: owner,
        quote_mint: mints[1],
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
    market.config = config_key;
    market.id = id;
    market.bump = market_bump;
    market.mints = mints;
    market.decimals = [6, 6];
    market.vaults_initialized = 63;
    market.state = protocol_core::OPEN;
    market.credits = [100; 6];
    market.credits[..2].fill(0);
    market.backing = [100, 100];
    market.terms = Terms {
        condition: [1; 32],
        yes_index: 1,
        no_index: 2,
        rules_hash: [2; 32],
        metadata_hash: [3; 32],
        metadata_uri: String::new(),
        trading_open: 0,
        trading_cutoff: i64::MAX,
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
        balances: [0, 0, 100, 100, 100, 100],
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
    for asset in 0..2 {
        baseline.push((
            pools[asset],
            serialized(&AssetPool {
                config: config_key,
                mint: mints[asset],
                token_program: token::ID,
                decimals: 6,
                liability: 200,
                bump: Pubkey::find_program_address(
                    &[b"pool", config_key.as_ref(), mints[asset].as_ref()],
                    &ID,
                )
                .1,
            }),
        ));
        baseline.push((
            credits[asset],
            serialized(&AssetCredit {
                pool: pools[asset],
                owner,
                available: 100,
                bump: Pubkey::find_program_address(
                    &[b"asset-credit", pools[asset].as_ref(), owner.as_ref()],
                    &ID,
                )
                .1,
            }),
        ));
    }
    for asset in 0..6 {
        baseline.push((
            mints[asset],
            token_data(RawMint {
                mint_authority: COption::Some(if asset < 2 { owner } else { market_key }),
                supply: if asset < 2 { 200 } else { 100 },
                decimals: 6,
                is_initialized: true,
                freeze_authority: COption::None,
            }),
        ));
        baseline.push((
            vaults[asset],
            token_data(RawAccount {
                mint: mints[asset],
                owner: if asset < 2 { pools[asset] } else { market_key },
                amount: if asset < 2 { 200 } else { 100 },
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
    let position_accounts = accounts::Positions {
        system_program: anchor_lang::system_program::ID,
        owner,
        market: market_key,
        wallet: wallet_key,
        yes_mint: mints[2],
        no_mint: mints[3],
        yes_vault: vaults[2],
        no_vault: vaults[3],
        token_program: token::ID,
        underlying_vault: vaults[0],
        pool: pools[0],
        credit: credits[0],
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
                    mints[3],
                    baseline
                        .iter()
                        .find(|(k, _)| *k == mints[3])
                        .unwrap()
                        .1
                        .clone(),
                )
            } else {
                (
                    vaults[0],
                    baseline
                        .iter()
                        .find(|(k, _)| *k == vaults[0])
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
                            collateral: 0,
                            amount: 1,
                        }
                        .data(),
                        1 => instruction::Merge {
                            collateral: 0,
                            amount: 1,
                        }
                        .data(),
                        _ => instruction::Redeem {
                            collateral: 0,
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
                    base_vault: vaults[0],
                    quote_vault: vaults[1],
                    base_pool: pools[0],
                    quote_pool: pools[1],
                }
                .to_account_metas(None);
                for asset in 2..6 {
                    accounts.push(AccountMeta::new(mints[asset], false));
                    accounts.push(AccountMeta::new(vaults[asset], false));
                }
                accounts.push(AccountMeta::new(wallet_key, false));
                accounts.push(AccountMeta::new_readonly(trader_key, false));
                accounts.push(AccountMeta::new(credits[0], false));
                Instruction {
                    program_id: ID,
                    accounts,
                    data: instruction::Place {
                        delegations: 0,
                        participants: 1,
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
                        },
                        plan: Plan {
                            deadline: i64::MAX - 2,
                            next_sequence: 0,
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
            collateral: 0,
            amount: 1,
        }
        .data(),
        instruction::Merge {
            collateral: 0,
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
