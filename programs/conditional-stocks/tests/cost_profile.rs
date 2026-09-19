//! Cost regression gates against compiled SBF, with deterministic synthetic accounts.
//! BPF_OUT_DIR=<fresh build directory> RUST_LOG=error cargo test -p conditional-stocks
//! --test cost_profile --offline -- --ignored --nocapture --test-threads=1
//! Oversized client messages are measured with a synthetic lookup table to isolate
//! runtime limits. The current production SDK does not use that table.
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
use conditional_stocks::delegation::TradingDelegate;
use conditional_stocks::pool::{pool_vault, AssetCredit, AssetPool};
use conditional_stocks::{accounts, instruction, state::*, ID};
use solana_program_test::ProgramTest;
use solana_sdk::{
    account::Account as BankAccount,
    message::{v0, AddressLookupTableAccount, VersionedMessage},
    signature::{Keypair, Signer},
    transaction::VersionedTransaction,
};

fn state_account<T: AccountSerialize + Space>(value: &T) -> BankAccount {
    let mut data = Vec::new();
    value.try_serialize(&mut data).unwrap();
    data.resize(8 + T::INIT_SPACE, 0);
    BankAccount {
        lamports: Rent::default().minimum_balance(data.len()),
        data,
        owner: ID,
        ..BankAccount::default()
    }
}
fn token_account<T: Pack>(value: T) -> BankAccount {
    let mut data = vec![0; T::LEN];
    T::pack(value, &mut data).unwrap();
    BankAccount {
        lamports: Rent::default().minimum_balance(data.len()),
        data,
        owner: token::ID,
        ..BankAccount::default()
    }
}
fn pda(seeds: &[&[u8]]) -> (Pubkey, u8) {
    Pubkey::find_program_address(seeds, &ID)
}

struct Fixture {
    leg_quantity: u64,
    price: u128,
    owner: Keypair,
    config: Pubkey,
    market_key: Pubkey,
    market: Market,
    mints: [Pubkey; 6],
    vaults: [Pubkey; 6],
    wallets: Vec<(Pubkey, Wallet, Pubkey, Trader)>,
    makers: Vec<(Pubkey, Order)>,
    grants: Vec<(Pubkey, TradingDelegate)>,
    sources: [Pubkey; 2],
    taker_funding: u8,
    branch: u8,
    side: u8,
    recipient: Pubkey,
}
impl Fixture {
    fn new(
        legs: usize,
        maker_funding: u8,
        taker_funding: u8,
        distinct: bool,
        long_uri: bool,
    ) -> Self {
        let owner = Keypair::new_from_array([42; 32]);
        let (config, _) = pda(&[b"config", owner.pubkey().as_ref()]);
        let (market_key, bump) = pda(&[b"market", config.as_ref(), &[77; 32]]);
        let mints = std::array::from_fn(|i| {
            if i < 2 {
                Pubkey::new_from_array([90 + i as u8; 32])
            } else {
                pda(&[b"claim", market_key.as_ref(), &[i as u8]]).0
            }
        });
        let vaults = std::array::from_fn(|i| {
            if i < 2 {
                pool_vault(&pda(&[b"pool", config.as_ref(), mints[i].as_ref()]).0)
            } else {
                pda(&[b"vault", market_key.as_ref(), &[i as u8]]).0
            }
        });
        let zero = vec![0; 8 + Market::INIT_SPACE];
        let mut market = Market::try_deserialize_unchecked(&mut zero.as_slice()).unwrap();
        market.config = config;
        market.id = [77; 32];
        market.bump = bump;
        market.mints = mints;
        market.decimals = [6; 2];
        market.vaults_initialized = 63;
        market.state = protocol_core::OPEN;
        market.sequence = [legs as u64, 0];
        market.backing = [1_000_000_000; 2];
        market.terms = Terms {
            condition: [1; 32],
            yes_index: 1,
            no_index: 2,
            rules_hash: [2; 32],
            metadata_hash: [3; 32],
            metadata_uri: if long_uri {
                "x".repeat(512)
            } else {
                "ipfs://cost-profile".into()
            },
            trading_open: 0,
            trading_cutoff: i64::MAX,
            tick: protocol_core::WAD,
            step: 1,
            min_notional: 1,
            max_quantity: 1_000_000,
            max_order: 10_000_000,
            max_wallet: 100_000_000,
            max_market: 1_000_000_000,
        };
        let mut wallets = Vec::new();
        let participants = if legs == 0 {
            1
        } else if distinct {
            legs + 1
        } else {
            2
        };
        for i in 0..participants {
            let key = if i == 0 {
                owner.pubkey()
            } else {
                Keypair::new_from_array([i as u8; 32]).pubkey()
            };
            let (wallet_key, wallet_bump) = pda(&[b"wallet", market_key.as_ref(), key.as_ref()]);
            let (trader_key, trader_bump) = pda(&[b"trader", config.as_ref(), key.as_ref()]);
            wallets.push((
                wallet_key,
                Wallet {
                    market: market_key,
                    owner: key,
                    balances: [1_000_000; 6],
                    open_notional: 0,
                    bump: wallet_bump,
                },
                trader_key,
                Trader {
                    config,
                    owner: key,
                    minimum_nonce: 0,
                    delegation_epoch: 0,
                    bump: trader_bump,
                },
            ));
        }
        market.credits = [participants as u128 * 1_000_000; 6];
        let mut makers = Vec::new();
        for i in 0..legs {
            let idx = if distinct { i + 1 } else { 1 };
            let wallet = &mut wallets[idx].1;
            let salt = [i as u8 + 1; 32];
            let (key, bump) = pda(&[b"order", market_key.as_ref(), wallet.owner.as_ref(), &salt]);
            let terms = OrderTerms {
                recipient: wallet.owner,
                salt,
                quantity: 100,
                price: 2 * protocol_core::WAD,
                expiry: i64::MAX - 1,
                nonce: 0,
                max_fee_bps: 1_000,
                branch: 0,
                side: 1,
                funding: maker_funding,
                tif: 0,
            };
            market.escrow[terms.asset()] += 100;
            market.open_notional += 200;
            wallet.open_notional += 200;
            makers.push((
                key,
                Order {
                    market: market_key,
                    owner: wallet.owner,
                    delegate: Pubkey::default(),
                    terms,
                    remaining: 100,
                    filled: 0,
                    reserved: 100,
                    open_notional: 200,
                    sequence: i as u64,
                    fee_carry: 0,
                    status: 1,
                    bump,
                },
            ));
        }
        Self {
            leg_quantity: 100,
            price: 2 * protocol_core::WAD,
            recipient: owner.pubkey(),
            owner,
            config,
            market_key,
            market,
            mints,
            vaults,
            wallets,
            makers,
            grants: Vec::new(),
            sources: [
                Pubkey::new_from_array([110; 32]),
                Pubkey::new_from_array([111; 32]),
            ],
            taker_funding,
            branch: 0,
            side: 0,
        }
    }
    fn scenario(
        mut self,
        branch: u8,
        side: u8,
        self_match: bool,
        separate_recipients: bool,
    ) -> Self {
        self.branch = branch;
        self.side = side;
        self.market.sequence = [0; 2];
        self.market.sequence[branch as usize] = self.makers.len() as u64;
        self.market.escrow = [0; 6];
        for (_, wallet, _, _) in &mut self.wallets {
            wallet.open_notional = 0;
        }
        for (key, order) in &mut self.makers {
            if self_match {
                order.owner = self.owner.pubkey();
                order.terms.recipient = order.owner;
            }
            order.terms.branch = branch;
            order.terms.side = 1 - side;
            order.reserved = if order.terms.side == 0 { 200 } else { 100 };
            (*key, order.bump) = pda(&[
                b"order",
                self.market_key.as_ref(),
                order.owner.as_ref(),
                &order.terms.salt,
            ]);
            self.market.escrow[order.terms.asset()] += order.reserved as u128;
            self.wallets
                .iter_mut()
                .find(|(_, w, _, _)| w.owner == order.owner)
                .unwrap()
                .1
                .open_notional += 200;
        }
        if separate_recipients {
            for i in 0..=self.makers.len() {
                let owner = Pubkey::new_from_array([50 + i as u8; 32]);
                let (wallet_key, bump) =
                    pda(&[b"wallet", self.market_key.as_ref(), owner.as_ref()]);
                let (trader_key, trader_bump) =
                    pda(&[b"trader", self.config.as_ref(), owner.as_ref()]);
                self.wallets.push((
                    wallet_key,
                    Wallet {
                        market: self.market_key,
                        owner,
                        balances: [1_000_000; 6],
                        open_notional: 0,
                        bump,
                    },
                    trader_key,
                    Trader {
                        config: self.config,
                        owner,
                        minimum_nonce: 0,
                        delegation_epoch: 0,
                        bump: trader_bump,
                    },
                ));
                if i == 0 {
                    self.recipient = owner;
                } else {
                    self.makers[i - 1].1.terms.recipient = owner;
                }
            }
        }
        self.market.credits = [self.wallets.len() as u128 * 1_000_000; 6];
        self
    }
    fn pool(&self, asset: usize) -> (Pubkey, u8) {
        pda(&[b"pool", self.config.as_ref(), self.mints[asset].as_ref()])
    }
    fn credit(&self, owner: &Pubkey, asset: usize) -> (Pubkey, u8) {
        pda(&[b"asset-credit", self.pool(asset).0.as_ref(), owner.as_ref()])
    }
    fn program(&self) -> ProgramTest {
        let mut program = ProgramTest::new("conditional_stocks", ID, None);
        program.prefer_bpf(true);
        let owner = self.owner.pubkey();
        program.add_account(
            owner,
            BankAccount {
                lamports: 10_000_000_000,
                ..BankAccount::default()
            },
        );
        program.add_account(
            self.config,
            state_account(&Config {
                seed_authority: owner,
                admin: owner,
                quote_mint: self.mints[1],
                roles: Roles {
                    market_admin: owner,
                    guardian: owner,
                    resolution_admin: owner,
                },
                paused: false,
                maker_bps: 10,
                taker_bps: 20,
                pending_admin: Pubkey::default(),
                admin_after: 0,
                bump: pda(&[b"config", owner.as_ref()]).1,
            }),
        );
        let mut market =
            Market::try_deserialize(&mut state_account(&self.market).data.as_slice()).unwrap();
        market.credits[0] = 0;
        market.credits[1] = 0;
        program.add_account(self.market_key, state_account(&market));
        for asset in 0..2 {
            let (key, bump) = self.pool(asset);
            program.add_account(
                key,
                state_account(&AssetPool {
                    config: self.config,
                    mint: self.mints[asset],
                    token_program: token::ID,
                    decimals: 6,
                    liability: self.market.liability(asset).unwrap() as u64,
                    bump,
                }),
            );
        }
        for (key, wallet, trader_key, trader) in &self.wallets {
            for asset in 0..2 {
                let (credit, bump) = self.credit(&wallet.owner, asset);
                program.add_account(
                    credit,
                    state_account(&AssetCredit {
                        pool: self.pool(asset).0,
                        owner: wallet.owner,
                        available: wallet.balances[asset],
                        bump,
                    }),
                );
            }
            let mut wallet =
                Wallet::try_deserialize(&mut state_account(wallet).data.as_slice()).unwrap();
            wallet.balances[0] = 0;
            wallet.balances[1] = 0;
            program.add_account(*key, state_account(&wallet));
            program.add_account(*trader_key, state_account(trader));
        }
        for (key, order) in &self.makers {
            program.add_account(*key, state_account(order));
        }
        for i in 0..6 {
            program.add_account(
                self.mints[i],
                token_account(RawMint {
                    mint_authority: COption::Some(if i < 2 { owner } else { self.market_key }),
                    supply: if i < 2 { 10_000_000_000 } else { 1_000_000_000 },
                    decimals: 6,
                    is_initialized: true,
                    freeze_authority: COption::None,
                }),
            );
            program.add_account(
                self.vaults[i],
                token_account(RawAccount {
                    mint: self.mints[i],
                    owner: if i < 2 {
                        self.pool(i).0
                    } else {
                        self.market_key
                    },
                    amount: self.market.liability(i).unwrap() as u64,
                    state: AccountState::Initialized,
                    ..RawAccount::default()
                }),
            );
        }
        for i in 0..2 {
            program.add_account(
                self.sources[i],
                token_account(RawAccount {
                    mint: self.mints[0],
                    owner,
                    amount: 1_000_000,
                    state: AccountState::Initialized,
                    ..RawAccount::default()
                }),
            );
        }
        program
    }
    fn place(&self, ioc: bool) -> Instruction {
        let salt = [200; 32];
        let owner = self.owner.pubkey();
        let mut metas = accounts::Place {
            authority: owner,
            delegation: None,
            owner,
            config: self.config,
            market: self.market_key,
            order: pda(&[b"order", self.market_key.as_ref(), owner.as_ref(), &salt]).0,
            token_program: token::ID,
            system_program: anchor_lang::system_program::ID,
            base_vault: self.vaults[0],
            quote_vault: self.vaults[1],
            base_pool: self.pool(0).0,
            quote_pool: self.pool(1).0,
        }
        .to_account_metas(None);
        for i in 2..6 {
            metas.push(AccountMeta::new(self.mints[i], false));
            metas.push(AccountMeta::new(self.vaults[i], false));
        }
        for (key, _) in &self.makers {
            metas.push(AccountMeta::new(*key, false));
        }
        for (key, _, trader, _) in &self.wallets {
            metas.push(AccountMeta::new(*key, false));
            metas.push(AccountMeta::new_readonly(*trader, false));
        }
        let mut credits = Vec::new();
        if self.taker_funding == 0 {
            credits.push(self.credit(&owner, usize::from(self.side == 0)).0);
        }
        for (_, maker) in &self.makers {
            if maker.terms.funding == 0
                && maker.terms.side == 0
                && maker.terms.price % protocol_core::WAD != 0
            {
                let credit = self.credit(&maker.owner, 1).0;
                if !credits.contains(&credit) {
                    credits.push(credit);
                }
            }
        }
        metas.extend(credits.into_iter().map(|key| AccountMeta::new(key, false)));
        metas.extend(
            self.grants
                .iter()
                .map(|(key, _)| AccountMeta::new_readonly(*key, false)),
        );
        Instruction {
            program_id: ID,
            accounts: metas,
            data: instruction::Place {
                delegations: self.grants.len() as u8,
                participants: self.wallets.len() as u8,
                terms: OrderTerms {
                    recipient: self.recipient,
                    salt,
                    quantity: self.leg_quantity * self.makers.len().max(1) as u64,
                    price: self.price,
                    expiry: i64::MAX - 1,
                    nonce: 0,
                    max_fee_bps: 1_000,
                    branch: self.branch,
                    side: self.side,
                    funding: self.taker_funding,
                    tif: u8::from(ioc),
                },
                plan: Plan {
                    deadline: i64::MAX - 2,
                    next_sequence: self.makers.len() as u64,
                    maker_bps: 10,
                    taker_bps: 20,
                    legs: self
                        .makers
                        .iter()
                        .map(|_| Leg {
                            quantity: self.leg_quantity,
                            expected_remaining: self.leg_quantity,
                        })
                        .collect(),
                },
            }
            .data(),
        }
    }
    fn positions(&self, data: Vec<u8>) -> Instruction {
        Instruction {
            program_id: ID,
            accounts: accounts::Positions {
                system_program: anchor_lang::system_program::ID,
                owner: self.owner.pubkey(),
                market: self.market_key,
                wallet: self.wallets[0].0,
                yes_mint: self.mints[2],
                no_mint: self.mints[3],
                yes_vault: self.vaults[2],
                no_vault: self.vaults[3],
                token_program: token::ID,
                underlying_vault: self.vaults[0],
                pool: self.pool(0).0,
                credit: self.credit(&self.owner.pubkey(), 0).0,
            }
            .to_account_metas(None),
            data,
        }
    }
}

async fn profile(label: &str, fixture: Fixture, ix: Instruction) {
    let checked_keys: Vec<_> = ix
        .accounts
        .iter()
        .filter(|a| a.is_writable && a.pubkey != fixture.owner.pubkey())
        .map(|a| a.pubkey)
        .collect();
    let mut program = fixture.program();
    for (key, grant) in &fixture.grants {
        program.add_account(*key, state_account(grant));
    }
    let table = AddressLookupTableAccount {
        key: Pubkey::new_from_array([220; 32]),
        addresses: ix
            .accounts
            .iter()
            .filter(|a| !a.is_signer)
            .map(|a| a.pubkey)
            .collect(),
    };
    // Canonical frozen ALT metadata: enum tag, no deactivation, last extension slot 0.
    let mut data = vec![0u8; 56];
    data[..4].copy_from_slice(&1u32.to_le_bytes());
    data[4..12].copy_from_slice(&u64::MAX.to_le_bytes());
    for address in &table.addresses {
        data.extend_from_slice(address.as_ref());
    }
    program.add_account(
        table.key,
        BankAccount {
            lamports: Rent::default().minimum_balance(data.len()),
            data,
            owner: "AddressLookupTab1e1111111111111111111111111"
                .parse()
                .unwrap(),
            ..BankAccount::default()
        },
    );
    let context = program.start_with_context().await;
    let mut limit_data = vec![2];
    limit_data.extend_from_slice(&1_400_000u32.to_le_bytes());
    let limit = Instruction {
        program_id: "ComputeBudget111111111111111111111111111111"
            .parse()
            .unwrap(),
        accounts: vec![],
        data: limit_data,
    };
    let instructions = [limit, ix];
    let message = VersionedMessage::V0(
        v0::Message::try_compile(
            &fixture.owner.pubkey(),
            &instructions,
            &[],
            context.last_blockhash,
        )
        .unwrap(),
    );
    let packet_bytes = message.serialize().len() + 65;
    let message = if packet_bytes > 1232 {
        VersionedMessage::V0(
            v0::Message::try_compile(
                &fixture.owner.pubkey(),
                &instructions,
                &[table],
                context.last_blockhash,
            )
            .unwrap(),
        )
    } else {
        message
    };
    let simulated_bytes = message.serialize().len() + 65;
    assert!(simulated_bytes <= 1232);
    let tx = VersionedTransaction::try_new(message, &[&fixture.owner]).unwrap();
    let result = context
        .banks_client
        .simulate_transaction(tx.clone())
        .await
        .unwrap();
    let detail = result.simulation_details.expect("SBF simulation details");
    let mint_cpis = detail
        .logs
        .iter()
        .filter(|l| l.contains("Instruction: MintTo"))
        .count();
    println!(
        "COST,{label},{},{packet_bytes},{simulated_bytes},{mint_cpis},{:?}",
        detail.units_consumed, result.result
    );
    assert_eq!(result.result, Some(Ok(())), "{label}: {:?}", detail.logs);
    assert!(
        detail.units_consumed < 330_000,
        "compute regression: {label}"
    );
    assert!(mint_cpis <= 4, "mint CPI aggregation regressed: {label}");
    if label.starts_with("place_")
        || label.starts_with("matrix_")
        || label.starts_with("rest_")
        || label == "ioc_no_fills"
    {
        let budget = 100_000
            + 11_000 * fixture.makers.len() as u64
            + 6_000 * fixture.wallets.len() as u64
            + 8_000 * mint_cpis as u64
            + 8_000
                * (instructions[1].accounts.len()
                    - 20
                    - fixture.makers.len()
                    - 2 * fixture.wallets.len()
                    - fixture.grants.len()) as u64
            + 7_000 * fixture.grants.len() as u64;
        assert!(
            detail.units_consumed <= budget,
            "SDK compute profile insufficient: {label}"
        );
    }
    context.banks_client.process_transaction(tx).await.unwrap();
    if label == "pool_eight_buyer_refunds" {
        for (_, maker) in &fixture.makers {
            let account = context
                .banks_client
                .get_account(fixture.credit(&maker.owner, 1).0)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                AssetCredit::try_deserialize(&mut account.data.as_slice())
                    .unwrap()
                    .available,
                1_000_001
            );
        }
        let account = context
            .banks_client
            .get_account(fixture.credit(&fixture.owner.pubkey(), 0).0)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            AssetCredit::try_deserialize(&mut account.data.as_slice())
                .unwrap()
                .available,
            1_000_000 - 8 * 99
        );
        let account = context
            .banks_client
            .get_account(fixture.market_key)
            .await
            .unwrap()
            .unwrap();
        let market = Market::try_deserialize(&mut account.data.as_slice()).unwrap();
        assert_eq!(&market.credits[..2], &[0, 0]);
        assert_eq!(market.escrow, [0; 6]);
        assert_eq!(market.open_notional, 0);
        assert_eq!(
            market.backing,
            [
                fixture.market.backing[0] + 8 * 99,
                fixture.market.backing[1] + 8 * 148
            ]
        );
    }
    // Successful execution must also leave every provided writable account
    // usable. Accounting is checked below and in the full validator suite.
    for key in checked_keys {
        assert!(context
            .banks_client
            .get_account(key)
            .await
            .unwrap()
            .is_some());
    }
    if label.starts_with("place_")
        || label.starts_with("matrix_")
        || label.starts_with("rest_")
        || label == "ioc_no_fills"
    {
        verify_settlement(&context, &fixture, label == "ioc_no_fills").await;
    }
}

/// Independent raw-unit reference for the fixed-price fixtures. It does not
/// call production fee/fill/settlement helpers and checks every participant,
/// including aliased owners/recipients, supply, custody, fees, and exposure.
async fn verify_settlement(
    context: &solana_program_test::ProgramTestContext,
    f: &Fixture,
    ioc: bool,
) {
    use std::collections::BTreeMap;
    let mut balances: BTreeMap<_, _> = f
        .wallets
        .iter()
        .map(|(_, w, _, _)| (w.owner, w.balances))
        .collect();
    let qty = 100 * f.makers.len().max(1) as u64;
    let collateral = if f.side == 0 { 1 } else { 0 };
    let asset = if f.taker_funding == 0 {
        collateral
    } else {
        2 + 2 * collateral + f.branch as usize
    };
    let reservation = qty * if f.side == 0 { 2 } else { 1 };
    balances.get_mut(&f.owner.pubkey()).unwrap()[asset] -= reservation;
    let mut minted = [0u64; 4];
    let mut fees = [0u64; 4];
    let mut taker_carry = 0;
    for (_, maker) in &f.makers {
        let buyer_is_taker = f.side == 0;
        let taker_gross = if buyer_is_taker { 100 } else { 200 };
        let taker_numerator = taker_gross * 20 + taker_carry;
        let taker_fee = taker_numerator / 10_000;
        taker_carry = taker_numerator % 10_000;
        let maker_fee = (if buyer_is_taker { 200 } else { 100 }) * 10 / 10_000;
        let (
            seller,
            seller_funding,
            buyer_recipient,
            buyer_fee,
            buyer,
            buyer_funding,
            seller_recipient,
            seller_fee,
        ) = if buyer_is_taker {
            (
                maker.owner,
                maker.terms.funding,
                f.recipient,
                taker_fee,
                f.owner.pubkey(),
                f.taker_funding,
                maker.terms.recipient,
                maker_fee,
            )
        } else {
            (
                f.owner.pubkey(),
                f.taker_funding,
                maker.terms.recipient,
                maker_fee,
                maker.owner,
                maker.terms.funding,
                f.recipient,
                taker_fee,
            )
        };
        for (collateral, gross, funding, funder, recipient, fee) in [
            (0, 100, seller_funding, seller, buyer_recipient, buyer_fee),
            (1, 200, buyer_funding, buyer, seller_recipient, seller_fee),
        ] {
            let active = 2 * collateral + f.branch as usize;
            let inactive = 2 * collateral + 1 - f.branch as usize;
            if funding == 0 {
                minted[2 * collateral] += gross;
                minted[2 * collateral + 1] += gross;
                balances.get_mut(&funder).unwrap()[inactive + 2] += gross;
            }
            balances.get_mut(&recipient).unwrap()[active + 2] += gross - fee;
            fees[active] += fee;
        }
    }
    if ioc && f.makers.is_empty() {
        balances.get_mut(&f.owner.pubkey()).unwrap()[asset] += reservation;
    }
    let resting = f.makers.is_empty() && !ioc;
    for (key, original, _, _) in &f.wallets {
        let account = context
            .banks_client
            .get_account(*key)
            .await
            .unwrap()
            .unwrap();
        let wallet = Wallet::try_deserialize(&mut account.data.as_slice()).unwrap();
        assert_eq!(wallet.balances[2..], balances[&original.owner][2..]);
        assert_eq!(wallet.balances[..2], [0, 0]);
        for (asset, expected) in balances[&original.owner].iter().take(2).enumerate() {
            let account = context
                .banks_client
                .get_account(f.credit(&original.owner, asset).0)
                .await
                .unwrap()
                .unwrap();
            let credit = AssetCredit::try_deserialize(&mut account.data.as_slice()).unwrap();
            assert_eq!(credit.available, *expected);
        }
        assert_eq!(
            wallet.open_notional,
            if resting && original.owner == f.owner.pubkey() {
                (qty * 2) as u128
            } else {
                0
            }
        );
    }
    let account = context
        .banks_client
        .get_account(f.market_key)
        .await
        .unwrap()
        .unwrap();
    let market = Market::try_deserialize(&mut account.data.as_slice()).unwrap();
    assert_eq!(
        market.open_notional,
        if resting { (qty * 2) as u128 } else { 0 }
    );
    assert_eq!(market.fees, fees);
    assert_eq!(
        market.backing,
        [
            f.market.backing[0] + minted[0],
            f.market.backing[1] + minted[2]
        ]
    );
    for i in 0..6 {
        assert_eq!(
            market.credits[i],
            if i < 2 {
                0
            } else {
                balances.values().map(|v| v[i] as u128).sum::<u128>()
            }
        );
        assert_eq!(
            market.escrow[i],
            if resting && i == asset {
                reservation as u128
            } else {
                0
            }
        );
    }
    for (i, amount) in minted.iter().enumerate() {
        let mint = context
            .banks_client
            .get_account(f.mints[i + 2])
            .await
            .unwrap()
            .unwrap();
        let vault = context
            .banks_client
            .get_account(f.vaults[i + 2])
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            RawMint::unpack(&mint.data).unwrap().supply,
            1_000_000_000 + amount
        );
        assert_eq!(
            RawAccount::unpack(&vault.data).unwrap().amount,
            f.market.liability(i + 2).unwrap() as u64 + amount
        );
    }
}

#[tokio::test]
#[ignore = "Requires fresh compiled SBF; no live network"]
async fn compiled_cost_profile() {
    assert!(std::env::var("BPF_OUT_DIR").is_ok());
    println!("COST_HEADER,label,compute_units,v0_bytes_without_lookup_tables,simulated_bytes,mint_cpis,result");
    for (name, size) in [
        ("Config", 8 + Config::INIT_SPACE),
        ("Market", 8 + Market::INIT_SPACE),
        ("Wallet", 8 + Wallet::INIT_SPACE),
        ("Trader", 8 + Trader::INIT_SPACE),
        ("Order", 8 + Order::INIT_SPACE),
        ("SPL_Mint", RawMint::LEN),
        ("SPL_TokenAccount", RawAccount::LEN),
    ] {
        println!(
            "RENT,{name},{size},{}",
            Rent::default().minimum_balance(size)
        );
    }
    for legs in [0, 1, 2, 4, 8] {
        for (funding_name, maker, taker) in [("whole", 0, 0), ("claims", 1, 1), ("mixed", 0, 1)] {
            let f = Fixture::new(legs, maker, taker, true, false);
            let ix = f.place(false);
            profile(&format!("place_{funding_name}_{legs}_distinct"), f, ix).await;
        }
    }
    for legs in [2, 4, 8] {
        let f = Fixture::new(legs, 0, 0, false, false);
        let ix = f.place(false);
        profile(&format!("place_whole_{legs}_shared"), f, ix).await;
    }
    for branch in 0..2 {
        for side in 0..2 {
            for maker in 0..2 {
                for taker in 0..2 {
                    for topology in 0..3 {
                        for recipients in [false, true] {
                            let f = Fixture::new(8, maker, taker, topology != 1, true).scenario(
                                branch,
                                side,
                                topology == 2,
                                recipients,
                            );
                            let ix = f.place(false);
                            profile(&format!("matrix_{branch}_{side}_{maker}_{taker}_{topology}_{recipients}"), f, ix).await;
                        }
                    }
                }
            }
        }
    }
    for (name, long_uri, ioc) in [
        ("rest_long_uri", true, false),
        ("ioc_no_fills", false, true),
    ] {
        let f = Fixture::new(0, 0, 0, true, long_uri);
        let ix = f.place(ioc);
        profile(name, f, ix).await;
    }
    for (name, data) in [
        (
            "split",
            instruction::Split {
                collateral: 0,
                amount: 100,
            }
            .data(),
        ),
        (
            "merge",
            instruction::Merge {
                collateral: 0,
                amount: 100,
            }
            .data(),
        ),
        (
            "redeem_invalid",
            instruction::Redeem {
                collateral: 0,
                yes_amount: 100,
                no_amount: 100,
            }
            .data(),
        ),
    ] {
        let mut f = Fixture::new(0, 0, 0, true, false);
        if name == "redeem_invalid" {
            f.market.state = protocol_core::REDEEMABLE;
            f.market.payouts = [1, 1];
        }
        let ix = f.positions(data);
        profile(name, f, ix).await;
    }
    let f = Fixture::new(1, 0, 0, true, false);
    let ix = Instruction {
        program_id: ID,
        accounts: {
            let mut keys = accounts::Cancel {
                delegation: None,
                actor: f.owner.pubkey(),
                market: f.market_key,
                order: f.makers[0].0,
                wallet: f.wallets[1].0,
                trader: f.wallets[1].2,
            }
            .to_account_metas(None);
            keys.push(AccountMeta::new(
                f.credit(&f.wallets[1].1.owner, 0).0,
                false,
            ));
            keys
        },
        data: instruction::Cancel {}.data(),
    };
    let mut f = f;
    f.market.state = protocol_core::FROZEN; // Permissionless release is now permitted.
    profile("cancel_frozen", f, ix).await;
    for withdraw in [false, true] {
        let f = Fixture::new(0, 0, 0, true, false);
        let owner = f.owner.pubkey();
        let ix = if withdraw {
            Instruction {
                program_id: ID,
                accounts: accounts::PoolTransfer {
                    system_program: anchor_lang::system_program::ID,
                    owner,
                    pool: f.pool(0).0,
                    credit: f.credit(&owner, 0).0,
                    mint: f.mints[0],
                    external: f.sources[1],
                    vault: f.vaults[0],
                    token_program: token::ID,
                }
                .to_account_metas(None),
                data: instruction::WithdrawPool {
                    amount: 100,
                    minimum_received: 100,
                }
                .data(),
            }
        } else {
            Instruction {
                program_id: ID,
                accounts: accounts::PoolTransfer {
                    system_program: anchor_lang::system_program::ID,
                    owner,
                    pool: f.pool(0).0,
                    credit: f.credit(&owner, 0).0,
                    mint: f.mints[0],
                    external: f.sources[0],
                    vault: f.vaults[0],
                    token_program: token::ID,
                }
                .to_account_metas(None),
                data: instruction::DepositPool {
                    amount: 100,
                    minimum_credit: 100,
                }
                .data(),
            }
        };
        profile(
            if withdraw {
                "withdraw_spl"
            } else {
                "deposit_spl"
            },
            f,
            ix,
        )
        .await;
    }
}

#[tokio::test]
#[ignore = "Requires fresh compiled SBF; no live network"]
async fn maintenance_is_atomic_refunds_rent_and_cannot_replay() {
    for case in 0..9 {
        let mut f = Fixture::new(8, 0, 0, false, false).scenario(0, 0, true, false);
        f.wallets[0].3.minimum_nonce = 1;
        for (key, order) in &mut f.makers {
            order.terms.salt[..8].copy_from_slice(&NONCE_BOUND_SALT);
            order.terms.salt[8..16].copy_from_slice(&0u64.to_le_bytes());
            (*key, order.bump) = pda(&[
                b"order",
                f.market_key.as_ref(),
                order.owner.as_ref(),
                &order.terms.salt,
            ]);
        }
        match case {
            1 => f.wallets[0].3.minimum_nonce = 0, // Not permanently invalidated.
            2 => f.makers[7].1.terms.nonce = 1,    // Last entry fails after earlier entries close.
            3 | 4 => {
                // Legacy salts only retire when trading can never resume.
                for (key, order) in &mut f.makers {
                    order.terms.salt[0] = 0;
                    (*key, order.bump) = pda(&[
                        b"order",
                        f.market_key.as_ref(),
                        order.owner.as_ref(),
                        &order.terms.salt,
                    ]);
                }
                if case == 4 {
                    f.market.state = protocol_core::FROZEN;
                }
            }
            5 => f.makers[7].1.owner = Pubkey::new_unique(),
            _ => {}
        }
        let mut accounts = accounts::RetireOrders {
            actor: f.owner.pubkey(),
            delegation: None,
            owner: f.owner.pubkey(),
            market: f.market_key,
            wallet: f.wallets[0].0,
            trader: f.wallets[0].2,
        }
        .to_account_metas(None);
        accounts.extend(
            f.makers
                .iter()
                .map(|(key, _)| AccountMeta::new(*key, false)),
        );
        if case == 6 {
            accounts[13] = accounts[6].clone();
        }
        let cancelling = case == 7;
        accounts.push(AccountMeta::new(f.credit(&f.owner.pubkey(), 0).0, false));
        if case == 8 {
            accounts[6].is_writable = false;
        }
        let ix = Instruction {
            program_id: ID,
            accounts,
            data: if cancelling {
                instruction::CancelOrders { order_count: 8 }.data()
            } else {
                instruction::RetireOrders { order_count: 8 }.data()
            },
        };
        let mut context = f.program().start_with_context().await;
        let keys: Vec<_> = [
            f.market_key,
            f.wallets[0].0,
            f.wallets[0].2,
            f.credit(&f.owner.pubkey(), 0).0,
        ]
        .into_iter()
        .chain(f.makers.iter().map(|(key, _)| *key))
        .collect();
        let mut before = Vec::new();
        for key in &keys {
            before.push(context.banks_client.get_account(*key).await.unwrap());
        }
        let owner_before = context
            .banks_client
            .get_account(f.owner.pubkey())
            .await
            .unwrap()
            .unwrap()
            .lamports;
        let tx = VersionedTransaction::try_new(
            VersionedMessage::V0(
                v0::Message::try_compile(&f.owner.pubkey(), &[ix], &[], context.last_blockhash)
                    .unwrap(),
            ),
            &[&f.owner],
        )
        .unwrap();
        if [0, 4, 7].contains(&case) {
            let simulation = context
                .banks_client
                .simulate_transaction(tx.clone())
                .await
                .unwrap();
            let units = simulation.simulation_details.unwrap().units_consumed;
            println!("MAINTENANCE_COST,{case},{units}");
            assert!(units <= 155_000, "maintenance SDK budget");
        }
        let result = context.banks_client.process_transaction(tx).await;
        if ![0, 4, 7].contains(&case) {
            assert!(result.is_err(), "maintenance case {case}");
            for (key, original) in keys.iter().zip(before) {
                assert_eq!(
                    context.banks_client.get_account(*key).await.unwrap(),
                    original,
                    "case {case} rollback"
                );
            }
            continue;
        }
        result.unwrap();
        let owner_after = context
            .banks_client
            .get_account(f.owner.pubkey())
            .await
            .unwrap()
            .unwrap()
            .lamports;
        let refund = if cancelling {
            0
        } else {
            8 * Rent::default().minimum_balance(8 + Order::INIT_SPACE)
        };
        assert_eq!(owner_after, owner_before + refund - 5_000);
        for (key, _) in &f.makers {
            let account = context.banks_client.get_account(*key).await.unwrap();
            if cancelling {
                let data = account.unwrap().data;
                let order = Order::try_deserialize(&mut data.as_slice()).unwrap();
                assert_eq!(
                    (
                        order.status,
                        order.remaining,
                        order.reserved,
                        order.open_notional
                    ),
                    (3, 0, 0, 0)
                );
            } else {
                assert!(account.is_none());
            }
        }
        let data = context
            .banks_client
            .get_account(f.wallets[0].0)
            .await
            .unwrap()
            .unwrap()
            .data;
        let wallet = Wallet::try_deserialize(&mut data.as_slice()).unwrap();
        assert_eq!(wallet.open_notional, 0);
        assert_eq!(wallet.balances[0], 0);
        let account = context
            .banks_client
            .get_account(f.credit(&f.owner.pubkey(), 0).0)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            AssetCredit::try_deserialize(&mut account.data.as_slice())
                .unwrap()
                .available,
            1_000_800
        );
        let data = context
            .banks_client
            .get_account(f.market_key)
            .await
            .unwrap()
            .unwrap()
            .data;
        let market = Market::try_deserialize(&mut data.as_slice()).unwrap();
        assert_eq!(market.open_notional, 0);
        assert_eq!(market.escrow, [0; 6]);
        assert_eq!(market.credits[0], 0);
        // After closure: old nonce rejects, and rebinding the same PDA's salt to
        // a newer nonce also rejects. Use fresh messages, not duplicate signatures.
        if case == 0 {
            for nonce in [0, 1] {
                let mut terms = f.makers[0].1.terms.clone();
                terms.nonce = nonce;
                let mut ix = f.place(false);
                ix.accounts.truncate(20);
                ix.accounts[4].pubkey = f.makers[0].0;
                ix.accounts.push(AccountMeta::new(f.wallets[0].0, false));
                ix.accounts
                    .push(AccountMeta::new_readonly(f.wallets[0].2, false));
                ix.accounts
                    .push(AccountMeta::new(f.credit(&f.owner.pubkey(), 0).0, false));
                ix.data = instruction::Place {
                    delegations: 0,
                    participants: 1,
                    terms,
                    plan: Plan {
                        deadline: i64::MAX - 2,
                        next_sequence: 8,
                        maker_bps: 10,
                        taker_bps: 20,
                        legs: vec![],
                    },
                }
                .data();
                let blockhash = context.get_new_latest_blockhash().await.unwrap();
                let tx = VersionedTransaction::try_new(
                    VersionedMessage::V0(
                        v0::Message::try_compile(&f.owner.pubkey(), &[ix], &[], blockhash).unwrap(),
                    ),
                    &[&f.owner],
                )
                .unwrap();
                assert!(context.banks_client.process_transaction(tx).await.is_err());
                assert!(context
                    .banks_client
                    .get_account(f.makers[0].0)
                    .await
                    .unwrap()
                    .is_none());
            }
        }
    }
}

#[tokio::test]
#[ignore = "Requires fresh compiled SBF; no live network"]
async fn eight_refunded_makers_use_distinct_global_credits_without_heap_failure() {
    let mut f = Fixture::new(8, 0, 0, true, false).scenario(0, 1, false, false);
    f.leg_quantity = 99;
    f.price = 3 * protocol_core::WAD / 2;
    f.market.terms.tick = f.price;
    f.market.escrow[1] = 8 * 149;
    f.market.open_notional = 8 * 149;
    for (_, maker) in &mut f.makers {
        maker.terms.price = f.price;
        maker.terms.quantity = 99;
        maker.remaining = 99;
        maker.reserved = 149;
        maker.open_notional = 149;
    }
    for (_, wallet, _, _) in f.wallets.iter_mut().skip(1) {
        wallet.open_notional = 149;
    }
    let ix = f.place(false);
    profile("pool_eight_buyer_refunds", f, ix).await;
}

#[tokio::test]
#[ignore = "Requires fresh compiled SBF; no live network"]
async fn compact_market_preserves_layout_future_resolution_space_and_donations() {
    for resolved in [false, true] {
        let mut f = Fixture::new(0, 0, 0, false, false);
        if resolved {
            f.market.state = protocol_core::REDEEMABLE;
            f.market.evidence_uri = "ipfs://evidence".into();
        }
        let mut program = f.program();
        let mut original = state_account(&f.market);
        original.lamports += 123;
        program.add_account(f.market_key, original.clone());
        let mut context = program.start_with_context().await;
        let ix = Instruction {
            program_id: ID,
            accounts: accounts::CompactMarket {
                admin: f.owner.pubkey(),
                config: f.config,
                market: f.market_key,
            }
            .to_account_metas(None),
            data: instruction::CompactMarket {}.data(),
        };
        let size = Market::allocation_size(
            f.market.terms.metadata_uri.len(),
            resolved.then_some(f.market.evidence_uri.len()),
        );
        let mut unauthorized = ix.clone();
        unauthorized.accounts[0].pubkey = context.payer.pubkey();
        let tx = VersionedTransaction::try_new(
            VersionedMessage::V0(
                v0::Message::try_compile(
                    &context.payer.pubkey(),
                    &[unauthorized],
                    &[],
                    context.last_blockhash,
                )
                .unwrap(),
            ),
            &[&context.payer],
        )
        .unwrap();
        assert!(context.banks_client.process_transaction(tx).await.is_err());
        assert_eq!(
            context
                .banks_client
                .get_account(f.market_key)
                .await
                .unwrap(),
            Some(original.clone())
        );
        for iteration in 0..2 {
            let before = context
                .banks_client
                .get_account(f.owner.pubkey())
                .await
                .unwrap()
                .unwrap()
                .lamports;
            let blockhash = context.get_new_latest_blockhash().await.unwrap();
            let tx = VersionedTransaction::try_new(
                VersionedMessage::V0(
                    v0::Message::try_compile(
                        &f.owner.pubkey(),
                        std::slice::from_ref(&ix),
                        &[],
                        blockhash,
                    )
                    .unwrap(),
                ),
                &[&f.owner],
            )
            .unwrap();
            context.banks_client.process_transaction(tx).await.unwrap();
            let account = context
                .banks_client
                .get_account(f.market_key)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(account.data.len(), size);
            assert_eq!(account.data, original.data[..size]);
            assert_eq!(
                account.lamports,
                Rent::default().minimum_balance(size) + 123
            );
            let actual = Market::try_deserialize(&mut account.data.as_slice()).unwrap();
            assert_eq!(actual.terms.metadata_uri, f.market.terms.metadata_uri);
            assert_eq!(actual.evidence_uri, f.market.evidence_uri);
            assert_eq!(actual.mints, f.market.mints);
            let after = context
                .banks_client
                .get_account(f.owner.pubkey())
                .await
                .unwrap()
                .unwrap()
                .lamports;
            let refund = if iteration == 0 {
                Rent::default().minimum_balance(original.data.len())
                    - Rent::default().minimum_balance(size)
            } else {
                0
            };
            assert_eq!(after, before + refund - 5000);
        }
    }
}

#[tokio::test]
#[ignore = "Requires fresh compiled SBF; no live network"]
async fn eight_distinct_maker_delegations_fit_default_heap_and_budget() {
    for funding in [0, 1, 2] {
        let mut f = Fixture::new(8, funding.min(1), funding.min(1), true, false);
        if funding == 2 {
            f = Fixture::new(8, 0, 0, true, false).scenario(0, 1, false, false);
            f.leg_quantity = 99;
            f.price = 3 * protocol_core::WAD / 2;
            f.market.terms.tick = f.price;
            f.market.escrow[1] = 8 * 149;
            f.market.open_notional = 8 * 149;
            for (_, maker) in &mut f.makers {
                maker.terms.price = f.price;
                maker.terms.quantity = 99;
                maker.remaining = 99;
                maker.reserved = 149;
                maker.open_notional = 149;
            }
            for (_, wallet, _, _) in f.wallets.iter_mut().skip(1) {
                wallet.open_notional = 149;
            }
        }
        for (index, (_, maker)) in f.makers.iter_mut().enumerate() {
            let delegate = Pubkey::new_from_array([180 + index as u8; 32]);
            let (key, bump) = pda(&[
                b"delegate",
                f.config.as_ref(),
                maker.owner.as_ref(),
                delegate.as_ref(),
            ]);
            maker.delegate = delegate;
            f.grants.push((
                key,
                TradingDelegate {
                    config: f.config,
                    owner: maker.owner,
                    delegate,
                    market: f.market_key,
                    epoch: 0,
                    expires_at: i64::MAX,
                    max_order_quote: 1000,
                    remaining_quote: 0,
                    max_fee_bps: 1000,
                    permissions: 3,
                    revoked: false,
                    bump,
                },
            ));
        }
        let ix = f.place(false);
        profile(
            if funding == 0 {
                "place_eight_delegated_whole"
            } else if funding == 2 {
                "pool_eight_buyer_refunds"
            } else {
                "place_eight_delegated_claims"
            },
            f,
            ix,
        )
        .await;
    }
}
