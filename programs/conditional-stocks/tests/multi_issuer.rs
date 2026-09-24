//! Multi-issuer markets against the compiled SBF program (never a host mock).
//!
//! BPF_OUT_DIR=$PWD/target/deploy RUST_LOG=error cargo test -p conditional-stocks \
//!   --offline --test multi_issuer -- --ignored --nocapture --test-threads=1
//!
//! Trading scenarios run on deterministic synthetic state: one market with a
//! classic 6-decimal quote and three base legs of one stock:
//!   leg 1: NVDAx replica (Token-2022, 8 decimals, admitted 63, multiplier ~1.0017)
//!   leg 2: classic SPL Token, 9 decimals, multiplier 1.0
//!   leg 3: NVDAon replica (Token-2022, 9 decimals, admitted 62, multiplier ~1.0017)
//! Every post-state (wallets, credit frames, market ledgers, orders, claim
//! supplies and vaults, pool liabilities) is compared with `World::engine`, an
//! independent reference that never calls the production rules crate.
//! Listing/admission runs end to end through real instructions and the
//! Token-2022 program shipped with solana-program-test.
#![allow(deprecated)]
#[path = "support/issuer_mint.rs"]
mod issuer_mint;

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
    spl_token::state::{Account as RawAccount, AccountState as ClassicState, Mint as RawMint},
};
use anchor_spl::token_2022::spl_token_2022::{
    extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
    state::{Account as T22Account, AccountState, Mint as T22Mint},
};
use conditional_stocks::pool::{AssetCredit, AssetPool};
use conditional_stocks::{accounts, instruction, state::*, ID};
use issuer_mint::*;
use solana_program_test::{ProgramTest, ProgramTestContext};
use solana_sdk::{
    account::{Account as BankAccount, AccountSharedData},
    instruction::InstructionError,
    message::{v0, AddressLookupTableAccount, VersionedMessage},
    signature::{Keypair, Signer},
    transaction::{TransactionError, VersionedTransaction},
};
use std::collections::{BTreeMap, BTreeSet};

const NOW: i64 = 1_790_000_000;
const CUTOFF: i64 = NOW + 1_000_000;
const WAD: u128 = 1_000_000_000_000_000_000;
const TICK: u128 = WAD / 1_000;
const MAKER_BPS: u16 = 10;
const TAKER_BPS: u16 = 20;
const BACKING: u64 = 1_000_000_000_000_000;
const HOLD: u64 = 10_000_000_000_000;
const FRAME: u64 = 10_000_000_000_000;
const ADMIN: u8 = 1;
const GUARDIAN: u8 = 2;
const OUTSIDER: u8 = 3;
/// Participant signer tags.
const T: u8 = 10; // taker
const S1: u8 = 11;
const S2: u8 = 12;
const S3: u8 = 13;
const B1: u8 = 14;
const B2: u8 = 15;
const B3: u8 = 16;
const R: u8 = 17; // separate recipient
const USERS: [u8; 8] = [T, S1, S2, S3, B1, B2, B3, R];
const NVDAX_NEW: f64 = 1.001701196801074;
const NVDAON_M: f64 = 1.0017152487959897;

fn signer(tag: u8) -> Keypair {
    Keypair::new_from_array([tag; 32])
}
fn user(tag: u8) -> Pubkey {
    signer(tag).pubkey()
}
fn pda(seeds: &[&[u8]]) -> (Pubkey, u8) {
    Pubkey::find_program_address(seeds, &ID)
}
fn t22() -> Pubkey {
    anchor_spl::token_2022::ID
}
fn code(error: ProtocolError) -> u32 {
    error as u32 + anchor_lang::error::ERROR_CODE_OFFSET
}
fn state_account<T: AccountSerialize + Space>(value: &T) -> BankAccount {
    let mut data = Vec::new();
    value.try_serialize(&mut data).unwrap();
    data.resize(data.len().max(8 + T::INIT_SPACE), 0);
    BankAccount {
        lamports: Rent::default().minimum_balance(data.len()),
        data,
        owner: ID,
        ..BankAccount::default()
    }
}
fn bytes(data: Vec<u8>, owner: Pubkey) -> BankAccount {
    BankAccount {
        lamports: Rent::default().minimum_balance(data.len()),
        data,
        owner,
        ..BankAccount::default()
    }
}
fn packed<P: Pack>(value: P, owner: Pubkey) -> BankAccount {
    let mut data = vec![0; P::LEN];
    P::pack(value, &mut data).unwrap();
    bytes(data, owner)
}
fn system(lamports: u64) -> BankAccount {
    BankAccount {
        lamports,
        ..BankAccount::default()
    }
}

// ---------------- independent reference arithmetic ----------------

/// Exact rational of a positive finite f64 by repeated (exact) doubling:
/// value = numerator / 2^k.
fn ratio(bits: u64) -> (u128, u32) {
    let value = f64::from_bits(bits);
    assert!(value.is_finite() && value > 0.0);
    let (mut v, mut k) = (value, 0);
    while v.fract() != 0.0 {
        v *= 2.0;
        k += 1;
    }
    (v as u128, k)
}
/// q share units at `scale` and multiplier `bits`, in raw issuer units.
fn raw(q: u64, scale: u64, bits: u64, up: bool) -> u64 {
    let (numerator, k) = ratio(bits);
    let tokens = (q as u128 * scale as u128) << k;
    let down = tokens / numerator;
    (down + u128::from(up && !tokens.is_multiple_of(numerator))) as u64
}
fn notional_up(q: u64, price: u128) -> u64 {
    (q as u128 * price).div_ceil(WAD) as u64
}
fn notional_down(q: u64, price: u128) -> u64 {
    (q as u128 * price / WAD) as u64
}
fn price(milli: u64) -> u128 {
    milli as u128 * TICK
}
fn claim_asset(c: usize, branch: usize) -> usize {
    3 * c + 1 + branch
}
fn order_collateral(terms: &OrderTerms) -> usize {
    if terms.side == 0 {
        0
    } else {
        terms.bases.trailing_zeros() as usize + 1
    }
}
fn funding_asset(terms: &OrderTerms) -> usize {
    let c = order_collateral(terms);
    if terms.funding == 0 {
        3 * c
    } else {
        claim_asset(c, terms.branch as usize)
    }
}
fn effective(issuer: &Issuer) -> u64 {
    issuer
        .extensions
        .iter()
        .find_map(|e| match e {
            Ext::ScaledUiAmount {
                multiplier,
                timestamp,
                new_multiplier,
                ..
            } => Some(if NOW >= *timestamp {
                *new_multiplier
            } else {
                *multiplier
            }),
            _ => None,
        })
        .unwrap_or(1f64.to_bits())
}

// ---------------- shared instruction builders ----------------

fn compute_budget() -> Instruction {
    let mut data = vec![2];
    data.extend_from_slice(&1_400_000u32.to_le_bytes());
    Instruction {
        program_id: "ComputeBudget111111111111111111111111111111"
            .parse()
            .unwrap(),
        accounts: vec![],
        data,
    }
}

async fn set_clock(context: &mut ProgramTestContext, now: i64) {
    let mut clock: Clock = context.banks_client.get_sysvar().await.unwrap();
    clock.unix_timestamp = now;
    context.set_sysvar(&clock);
}

/// Sends `ixs` (after a compute budget) signed by `signers[0]` as payer.
/// Returns the custom error code of a failure (u32::MAX for other errors).
/// Messages above the 1232-byte packet limit (three touched legs with many
/// participants) use a v0 message with a synthetic, frozen lookup table.
async fn send(
    context: &mut ProgramTestContext,
    ixs: &[Instruction],
    signers: &[&Keypair],
) -> std::result::Result<(), u32> {
    let hash = context.get_new_latest_blockhash().await.unwrap();
    set_clock(context, NOW).await;
    let mut all = vec![compute_budget()];
    all.extend_from_slice(ixs);
    let payer = signers[0].pubkey();
    let mut message =
        VersionedMessage::V0(v0::Message::try_compile(&payer, &all, &[], hash).unwrap());
    if message.serialize().len() + 1 + 64 * signers.len() > 1232 {
        let mut addresses = BTreeSet::new();
        for ix in ixs {
            for meta in &ix.accounts {
                if !meta.is_signer {
                    addresses.insert(meta.pubkey);
                }
            }
        }
        let table = AddressLookupTableAccount {
            key: Pubkey::new_unique(),
            addresses: addresses.into_iter().collect(),
        };
        // Frozen table metadata: type tag, never deactivated, extended at slot 0.
        let mut data = vec![0u8; 56];
        data[..4].copy_from_slice(&1u32.to_le_bytes());
        data[4..12].copy_from_slice(&u64::MAX.to_le_bytes());
        for address in &table.addresses {
            data.extend_from_slice(address.as_ref());
        }
        let owner = "AddressLookupTab1e1111111111111111111111111"
            .parse()
            .unwrap();
        context.set_account(&table.key, &AccountSharedData::from(bytes(data, owner)));
        message =
            VersionedMessage::V0(v0::Message::try_compile(&payer, &all, &[table], hash).unwrap());
        assert!(
            message.serialize().len() + 1 + 64 * signers.len() <= 1232,
            "message too large even with a lookup table"
        );
    }
    let tx = VersionedTransaction::try_new(message, signers).unwrap();
    match context.banks_client.process_transaction(tx).await {
        Ok(()) => Ok(()),
        Err(error) => match error.unwrap() {
            TransactionError::InstructionError(_, InstructionError::Custom(c)) => Err(c),
            other => {
                println!("non-custom failure: {other:?}");
                Err(u32::MAX)
            }
        },
    }
}

async fn fetch<T: AccountDeserialize>(context: &mut ProgramTestContext, key: Pubkey) -> T {
    let account = context
        .banks_client
        .get_account(key)
        .await
        .unwrap()
        .unwrap_or_else(|| panic!("missing account {key}"));
    T::try_deserialize(&mut account.data.as_slice()).unwrap()
}
async fn raw_account(context: &mut ProgramTestContext, key: Pubkey) -> BankAccount {
    context
        .banks_client
        .get_account(key)
        .await
        .unwrap()
        .unwrap()
}
/// Token amount of a classic or Token-2022 account.
async fn token_amount(context: &mut ProgramTestContext, key: Pubkey) -> u64 {
    let account = raw_account(context, key).await;
    StateWithExtensions::<T22Account>::unpack(&account.data)
        .unwrap()
        .base
        .amount
}
async fn mint_supply(context: &mut ProgramTestContext, key: Pubkey) -> u64 {
    let account = raw_account(context, key).await;
    StateWithExtensions::<T22Mint>::unpack(&account.data)
        .unwrap()
        .base
        .supply
}

fn pool_key(config: &Pubkey, mint: &Pubkey) -> (Pubkey, u8) {
    pda(&[b"pool", config.as_ref(), mint.as_ref()])
}
fn pool_vault_key(pool: &Pubkey) -> (Pubkey, u8) {
    pda(&[b"pool-vault", pool.as_ref()])
}
fn claim_mint(market: &Pubkey, asset: usize) -> Pubkey {
    pda(&[b"claim", market.as_ref(), &[asset as u8]]).0
}
fn claim_vault(market: &Pubkey, asset: usize) -> Pubkey {
    pda(&[b"vault", market.as_ref(), &[asset as u8]]).0
}
fn credit_key(pool: &Pubkey, owner: &Pubkey) -> (Pubkey, u8) {
    pda(&[b"asset-credit", pool.as_ref(), owner.as_ref()])
}
fn wallet_key(market: &Pubkey, owner: &Pubkey) -> (Pubkey, u8) {
    pda(&[b"wallet", market.as_ref(), owner.as_ref()])
}
fn trader_key(config: &Pubkey, owner: &Pubkey) -> (Pubkey, u8) {
    pda(&[b"trader", config.as_ref(), owner.as_ref()])
}
fn order_key(market: &Pubkey, owner: &Pubkey, salt: &[u8; 32]) -> (Pubkey, u8) {
    pda(&[b"order", market.as_ref(), owner.as_ref(), salt])
}

/// Everything `place` needs besides terms and plan, in wire order.
struct PlaceAccounts {
    owner: Pubkey,
    salt: [u8; 32],
    touched: u8,
    makers: Vec<Pubkey>,
    participants: Vec<Pubkey>,
    frames: Vec<Pubkey>,
    quote_writable: bool,
    leg_writable: [bool; 4],
}

fn place_metas(
    config: &Pubkey,
    market_key: &Pubkey,
    market: &Market,
    p: &PlaceAccounts,
) -> Vec<AccountMeta> {
    let quote_pool = pool_key(config, &market.mints[0]).0;
    let mut metas = accounts::Place {
        authority: p.owner,
        owner: p.owner,
        config: *config,
        market: *market_key,
        order: order_key(market_key, &p.owner, &p.salt).0,
        token_program: token::ID,
        system_program: anchor_lang::system_program::ID,
        quote_pool,
        quote_vault: pool_vault_key(&quote_pool).0,
        delegation: None,
    }
    .to_account_metas(None);
    let claims = |metas: &mut Vec<AccountMeta>, c: usize, writable: bool| {
        for branch in 0..2 {
            let asset = claim_asset(c, branch);
            for key in [
                claim_mint(market_key, asset),
                claim_vault(market_key, asset),
            ] {
                metas.push(if writable {
                    AccountMeta::new(key, false)
                } else {
                    AccountMeta::new_readonly(key, false)
                });
            }
        }
    };
    claims(&mut metas, 0, p.quote_writable);
    for c in 1..=3 {
        if p.touched & (1 << (c - 1)) == 0 {
            continue;
        }
        let pool = pool_key(config, &market.mints[3 * c]).0;
        metas.push(AccountMeta::new_readonly(pool, false));
        metas.push(AccountMeta::new_readonly(pool_vault_key(&pool).0, false));
        metas.push(AccountMeta::new_readonly(market.mints[3 * c], false));
        claims(&mut metas, c, p.leg_writable[c]);
    }
    for key in &p.makers {
        metas.push(AccountMeta::new(*key, false));
    }
    for owner in &p.participants {
        metas.push(AccountMeta::new(wallet_key(market_key, owner).0, false));
        metas.push(AccountMeta::new_readonly(
            trader_key(config, owner).0,
            false,
        ));
    }
    for key in &p.frames {
        metas.push(AccountMeta::new(*key, false));
    }
    metas
}

fn positions_ix(
    config: &Pubkey,
    market_key: &Pubkey,
    market: &Market,
    owner: Pubkey,
    c: usize,
    data: Vec<u8>,
) -> Instruction {
    let pool = pool_key(config, &market.mints[3 * c]).0;
    Instruction {
        program_id: ID,
        accounts: accounts::Positions {
            owner,
            market: *market_key,
            wallet: wallet_key(market_key, &owner).0,
            yes_mint: market.mints[claim_asset(c, 0)],
            no_mint: market.mints[claim_asset(c, 1)],
            yes_vault: claim_vault(market_key, claim_asset(c, 0)),
            no_vault: claim_vault(market_key, claim_asset(c, 1)),
            token_program: token::ID,
            pool,
            credit: credit_key(&pool, &owner).0,
            underlying_vault: pool_vault_key(&pool).0,
            underlying_mint: market.mints[3 * c],
        }
        .to_account_metas(None),
        data,
    }
}

// ---------------- synthetic world + reference engine ----------------

#[derive(Clone)]
struct Collateral {
    mint: Pubkey,
    program: Pubkey,
    decimals: u8,
    admitted: u16,
    /// Token-2022 issuer replica; None is a classic SPL mint.
    issuer: Option<Issuer>,
    vault_frozen: bool,
    /// Raw units missing from the pool vault (an issuer seizure).
    shortfall: u64,
}

#[derive(Clone)]
struct World {
    config: Pubkey,
    cfg: Config,
    market_key: Pubkey,
    market: Market,
    collaterals: Vec<Collateral>,
    wallets: BTreeMap<Pubkey, Wallet>,
    frames: BTreeMap<(Pubkey, usize), u64>,
    orders: Vec<(Pubkey, Order)>,
    supply: [u64; ASSETS],
}

/// Reference result of one placement.
struct Outcome {
    world: World,
    taker: (Pubkey, Order),
    frames: Vec<(Pubkey, usize)>,
    quote_writable: bool,
    leg_writable: [bool; 4],
    /// (collateral, raw, quote, buyer fee, seller fee, surplus refund)
    fills: Vec<(usize, u64, u64, u64, u64, u64)>,
}

impl World {
    fn new() -> Self {
        let admin = user(ADMIN);
        let (config, config_bump) = pda(&[b"config", admin.as_ref()]);
        let id = [9u8; 32];
        let (market_key, market_bump) = pda(&[b"market", config.as_ref(), &id]);
        let collaterals = vec![
            Collateral {
                mint: Pubkey::new_from_array([200; 32]),
                program: token::ID,
                decimals: 6,
                admitted: 0,
                issuer: None,
                vault_frozen: false,
                shortfall: 0,
            },
            Collateral {
                mint: Pubkey::new_from_array([201; 32]),
                program: t22(),
                decimals: 8,
                admitted: 63,
                issuer: Some(nvdax()),
                vault_frozen: false,
                shortfall: 0,
            },
            Collateral {
                mint: Pubkey::new_from_array([202; 32]),
                program: token::ID,
                decimals: 9,
                admitted: 0,
                issuer: None,
                vault_frozen: false,
                shortfall: 0,
            },
            Collateral {
                mint: Pubkey::new_from_array([203; 32]),
                program: t22(),
                decimals: 9,
                admitted: 62,
                issuer: Some(nvdaon()),
                vault_frozen: false,
                shortfall: 0,
            },
        ];
        let zero = vec![0u8; 8 + Market::INIT_SPACE];
        let mut market = Market::try_deserialize_unchecked(&mut zero.as_slice()).unwrap();
        market.ledgers();
        market.config = config;
        market.id = id;
        market.bump = market_bump;
        market.terms = Terms {
            condition: [1; 32],
            yes_index: 1,
            no_index: 2,
            rules_hash: [2; 32],
            metadata_hash: [3; 32],
            metadata_uri: "ipfs://multi-issuer".into(),
            trading_open: 0,
            trading_cutoff: CUTOFF,
            share_decimals: 6,
            tick: TICK,
            step: 1_000,
            min_notional: 1_000,
            max_quantity: 1_000_000_000,
            max_order: 1_000_000_000_000,
            max_wallet: 10_000_000_000_000,
            max_market: 100_000_000_000_000,
        };
        market.bases = 3;
        market.state = protocol_core::OPEN;
        market.vaults_initialized = 0xFFF;
        let mut supply = [0; ASSETS];
        for (c, spec) in collaterals.iter().enumerate() {
            market.mints[3 * c] = spec.mint;
            market.decimals[c] = spec.decimals;
            market.pool_bumps[c] = pool_key(&config, &spec.mint).1;
            market.backing[c] = BACKING;
            for branch in 0..2 {
                let asset = claim_asset(c, branch);
                market.mints[asset] = claim_mint(&market_key, asset);
                supply[asset] = BACKING;
            }
            if c > 0 {
                market.legs[c - 1] = BaseLeg {
                    scale: 10u64.pow(u32::from(spec.decimals - 6)),
                    multiplier: spec.issuer.as_ref().map_or(1f64.to_bits(), effective),
                    active: true,
                };
            }
        }
        let mut wallets = BTreeMap::new();
        let mut frames = BTreeMap::new();
        for tag in USERS {
            let owner = user(tag);
            let mut balances = [HOLD; ASSETS];
            for c in 0..4 {
                balances[3 * c] = 0;
                frames.insert((owner, c), FRAME);
            }
            wallets.insert(
                owner,
                Wallet {
                    market: market_key,
                    owner,
                    balances,
                    open_notional: 0,
                    bump: wallet_key(&market_key, &owner).1,
                },
            );
        }
        let cfg = Config {
            seed_authority: admin,
            admin,
            quote_mint: collaterals[0].mint,
            roles: Roles {
                market_admin: admin,
                guardian: user(GUARDIAN),
                resolution_admin: admin,
            },
            paused: false,
            maker_bps: MAKER_BPS,
            taker_bps: TAKER_BPS,
            pending_admin: Pubkey::default(),
            admin_after: 0,
            bump: config_bump,
        };
        let mut world = Self {
            config,
            cfg,
            market_key,
            market,
            collaterals,
            wallets,
            frames,
            orders: vec![],
            supply,
        };
        for asset in 0..ASSETS {
            if asset % 3 != 0 {
                world.market.credits[asset] = world
                    .wallets
                    .values()
                    .map(|w| w.balances[asset] as u128)
                    .sum();
            }
        }
        world
    }

    fn scale(&self, c: usize) -> u64 {
        self.market.legs[c - 1].scale
    }
    fn live(&self, c: usize) -> u64 {
        match (c, &self.collaterals[c].issuer) {
            (0, _) | (_, None) => 1f64.to_bits(),
            (_, Some(issuer)) => effective(issuer),
        }
    }
    fn pool(&self, c: usize) -> Pubkey {
        pool_key(&self.config, &self.collaterals[c].mint).0
    }
    fn frame_key(&self, owner: &Pubkey, c: usize) -> Pubkey {
        credit_key(&self.pool(c), owner).0
    }
    fn issuer_mut(&mut self, c: usize) -> &mut Issuer {
        self.collaterals[c].issuer.as_mut().unwrap()
    }
    fn pool_liability(&self, c: usize) -> u64 {
        let frames: u64 = self
            .frames
            .iter()
            .filter(|((_, fc), _)| *fc == c)
            .map(|(_, v)| *v)
            .sum();
        frames
            + (self.market.escrow[3 * c] + self.market.credits[3 * c]) as u64
            + self.market.backing[c]
    }
    fn vault_balance(&self, asset: usize) -> u64 {
        (self.market.credits[asset] + self.market.escrow[asset]) as u64 + self.market.fees[asset]
    }

    fn debit(&mut self, owner: &Pubkey, asset: usize, amount: u64) {
        if asset.is_multiple_of(3) {
            let frame = self.frames.get_mut(&(*owner, asset / 3)).unwrap();
            *frame = frame.checked_sub(amount).expect("frame underflow");
        } else {
            let wallet = self.wallets.get_mut(owner).unwrap();
            wallet.balances[asset] = wallet.balances[asset]
                .checked_sub(amount)
                .expect("wallet underflow");
            self.market.credits[asset] -= amount as u128;
        }
    }
    fn credit(&mut self, owner: &Pubkey, asset: usize, amount: u64) {
        if asset.is_multiple_of(3) {
            *self.frames.get_mut(&(*owner, asset / 3)).unwrap() += amount;
        } else {
            self.wallets.get_mut(owner).unwrap().balances[asset] += amount;
            self.market.credits[asset] += amount as u128;
        }
    }
    fn exposure(&mut self, owner: &Pubkey, add: u64, sub: u64) {
        let wallet = self.wallets.get_mut(owner).unwrap();
        wallet.open_notional = wallet.open_notional + add as u128 - sub as u128;
        self.market.open_notional = self.market.open_notional + add as u128 - sub as u128;
    }

    #[allow(clippy::too_many_arguments)]
    fn terms(
        &self,
        owner: u8,
        salt: u8,
        side: u8,
        branch: u8,
        funding: u8,
        bases: u8,
        quantity: u64,
        milli: u64,
        tif: u8,
    ) -> OrderTerms {
        OrderTerms {
            recipient: user(owner),
            salt: [salt; 32],
            quantity,
            price: price(milli),
            expiry: NOW + 5_000,
            nonce: 0,
            max_fee_bps: 1_000,
            branch,
            side,
            funding,
            tif,
            bases,
        }
    }

    /// A resting maker order placed earlier at the leg's LISTING multiplier.
    fn add_order(&mut self, terms: OrderTerms) -> usize {
        let owner = self.owner_of(&terms);
        let notional = notional_up(terms.quantity, terms.price);
        let reserved = if terms.side == 0 {
            notional
        } else {
            let c = order_collateral(&terms);
            raw(
                terms.quantity,
                self.scale(c),
                self.market.legs[c - 1].multiplier,
                true,
            )
        };
        let asset = funding_asset(&terms);
        self.debit(&owner, asset, reserved);
        self.market.escrow[asset] += reserved as u128;
        self.exposure(&owner, notional, 0);
        let branch = terms.branch as usize;
        let sequence = self.market.sequence[branch];
        self.market.sequence[branch] += 1;
        self.market.recent[branch * RECENT + sequence as usize % RECENT] = Placement {
            ticks: (terms.price / self.market.terms.tick) as u64,
            side: terms.side,
        };
        let (key, bump) = order_key(&self.market_key, &owner, &terms.salt);
        self.orders.push((
            key,
            Order {
                market: self.market_key,
                owner,
                delegate: Pubkey::default(),
                terms,
                remaining: 0,
                filled: 0,
                reserved,
                open_notional: notional,
                sequence,
                fee_carry: 0,
                status: 1,
                bump,
            },
        ));
        let order = &mut self.orders.last_mut().unwrap().1;
        order.remaining = order.terms.quantity;
        self.orders.len() - 1
    }
    /// Maker orders built by `terms` are owned by their (default) recipient.
    fn owner_of(&self, terms: &OrderTerms) -> Pubkey {
        terms.recipient
    }

    /// Independent settlement of one placement.
    fn engine(&self, owner: Pubkey, terms: &OrderTerms, fills: &[(usize, u64)]) -> Outcome {
        let mut w = self.clone();
        let branch = terms.branch as usize;
        let notional = notional_up(terms.quantity, terms.price);
        let taker_collateral = order_collateral(terms);
        let reserved = if terms.side == 0 {
            notional
        } else {
            raw(
                terms.quantity,
                w.scale(taker_collateral),
                w.live(taker_collateral),
                true,
            )
        };
        let asset = funding_asset(terms);
        w.debit(&owner, asset, reserved);
        w.market.escrow[asset] += reserved as u128;
        w.exposure(&owner, notional, 0);
        let sequence = w.market.sequence[branch];
        w.market.sequence[branch] += 1;
        let (taker_key, bump) = order_key(&w.market_key, &owner, &terms.salt);
        let mut taker = Order {
            market: w.market_key,
            owner,
            delegate: Pubkey::default(),
            terms: terms.clone(),
            remaining: terms.quantity,
            filled: 0,
            reserved,
            open_notional: notional,
            sequence,
            fee_carry: 0,
            status: 1,
            bump,
        };
        let mut frames = vec![];
        if terms.funding == 0 {
            frames.push((owner, taker_collateral));
        }
        let mut quote_writable = false;
        let mut leg_writable = [false; 4];
        let mut outcomes = vec![];
        for &(index, q) in fills {
            let mut maker = w.orders[index].1.clone();
            let taker_buys = terms.side == 0;
            let maker_price = maker.terms.price;
            let (buy, sell) = if taker_buys {
                (&mut taker, &mut maker)
            } else {
                (&mut maker, &mut taker)
            };
            let base = order_collateral(&sell.terms);
            let quote = notional_down(q, maker_price);
            let buyer_reduction = notional_up(buy.remaining, buy.terms.price)
                - notional_up(buy.remaining - q, buy.terms.price);
            let improvement = buyer_reduction - quote;
            let seller_reduction = notional_up(sell.remaining, sell.terms.price)
                - notional_up(sell.remaining - q, sell.terms.price);
            let delivered = raw(q, w.scale(base), w.live(base), false);
            let (buyer_bps, seller_bps) = if taker_buys {
                (TAKER_BPS, MAKER_BPS)
            } else {
                (MAKER_BPS, TAKER_BPS)
            };
            let numerator = delivered as u128 * buyer_bps as u128 + buy.fee_carry as u128;
            let buyer_fee = (numerator / 10_000) as u64;
            buy.fee_carry = (numerator % 10_000) as u16;
            let numerator = quote as u128 * seller_bps as u128 + sell.fee_carry as u128;
            let seller_fee = (numerator / 10_000) as u64;
            sell.fee_carry = (numerator % 10_000) as u16;
            let (buy_asset, sell_asset) = (funding_asset(&buy.terms), funding_asset(&sell.terms));
            w.market.escrow[buy_asset] -= buyer_reduction as u128;
            w.market.escrow[sell_asset] -= delivered as u128;
            w.credit(&buy.owner, buy_asset, improvement);
            w.exposure(&buy.owner, 0, buyer_reduction);
            w.exposure(&sell.owner, 0, seller_reduction);
            // Base leg claims.
            if sell.terms.funding == 0 {
                w.market.backing[base] += delivered;
                w.credit(&sell.owner, claim_asset(base, 1 - branch), delivered);
                w.supply[claim_asset(base, 0)] += delivered;
                w.supply[claim_asset(base, 1)] += delivered;
                leg_writable[base] = true;
            }
            w.credit(
                &buy.terms.recipient,
                claim_asset(base, branch),
                delivered - buyer_fee,
            );
            w.market.fees[claim_asset(base, branch)] += buyer_fee;
            // Quote claims.
            if buy.terms.funding == 0 {
                w.market.backing[0] += quote;
                w.credit(&buy.owner, claim_asset(0, 1 - branch), quote);
                w.supply[claim_asset(0, 0)] += quote;
                w.supply[claim_asset(0, 1)] += quote;
                quote_writable = true;
            }
            w.credit(
                &sell.terms.recipient,
                claim_asset(0, branch),
                quote - seller_fee,
            );
            w.market.fees[claim_asset(0, branch)] += seller_fee;
            buy.remaining -= q;
            buy.filled += q;
            buy.reserved = notional_up(buy.remaining, buy.terms.price);
            buy.open_notional -= buyer_reduction;
            sell.remaining -= q;
            sell.filled += q;
            assert!(
                delivered <= sell.reserved,
                "reference: delivery exceeds reservation"
            );
            sell.reserved -= delivered;
            sell.open_notional -= seller_reduction;
            if buy.remaining == 0 {
                buy.status = 2;
            }
            let mut surplus = 0;
            if sell.remaining == 0 {
                sell.status = 2;
                surplus = sell.reserved;
                if surplus > 0 {
                    w.market.escrow[sell_asset] -= surplus as u128;
                    w.credit(&sell.owner, sell_asset, surplus);
                    sell.reserved = 0;
                    if sell_asset.is_multiple_of(3) && taker_buys {
                        frames.push((sell.owner, base));
                    }
                }
            }
            if !taker_buys && buy.terms.funding == 0 && improvement > 0 {
                frames.push((buy.owner, 0));
            }
            outcomes.push((base, delivered, quote, buyer_fee, seller_fee, surplus));
            w.orders[index].1 = maker;
        }
        if taker.terms.tif == 1 && taker.remaining != 0 {
            w.market.escrow[asset] -= taker.reserved as u128;
            w.credit(&owner, asset, taker.reserved);
            w.exposure(&owner, 0, taker.open_notional);
            taker.remaining = 0;
            taker.reserved = 0;
            taker.open_notional = 0;
            taker.status = 3;
        }
        let mut seen = BTreeSet::new();
        frames.retain(|f| seen.insert(*f));
        Outcome {
            world: w,
            taker: (taker_key, taker),
            frames,
            quote_writable,
            leg_writable,
            fills: outcomes,
        }
    }

    fn place_ix(
        &self,
        owner: Pubkey,
        terms: &OrderTerms,
        fills: &[(usize, u64)],
        touched: u8,
        outcome: Option<&Outcome>,
    ) -> Instruction {
        let next = self.market.sequence[terms.branch as usize];
        self.planned_ix(owner, terms, fills, touched, outcome, next, 0)
    }

    /// A placement with an explicit plan: `fills` are the PLANNED legs (the
    /// chain may skip or cap them), made against book sequence `next`.
    #[allow(clippy::too_many_arguments)]
    fn planned_ix(
        &self,
        owner: Pubkey,
        terms: &OrderTerms,
        fills: &[(usize, u64)],
        touched: u8,
        outcome: Option<&Outcome>,
        next: u64,
        min_fill: u64,
    ) -> Instruction {
        let mut participants = BTreeSet::from([owner, terms.recipient]);
        for (index, _) in fills {
            let order = &self.orders[*index].1;
            participants.insert(order.owner);
            participants.insert(order.terms.recipient);
        }
        let participants: Vec<_> = participants.into_iter().collect();
        let (frames, quote_writable, leg_writable) = match outcome {
            Some(o) => (
                o.frames
                    .iter()
                    .map(|(k, c)| self.frame_key(k, *c))
                    .collect(),
                o.quote_writable,
                o.leg_writable,
            ),
            None => (
                if terms.funding == 0 {
                    vec![self.frame_key(&owner, order_collateral(terms))]
                } else {
                    vec![]
                },
                true,
                [true; 4],
            ),
        };
        let accounts = PlaceAccounts {
            owner,
            salt: terms.salt,
            touched,
            makers: fills.iter().map(|(i, _)| self.orders[*i].0).collect(),
            participants: participants.clone(),
            frames,
            quote_writable,
            leg_writable,
        };
        Instruction {
            program_id: ID,
            accounts: place_metas(&self.config, &self.market_key, &self.market, &accounts),
            data: instruction::Place {
                terms: terms.clone(),
                plan: Plan {
                    deadline: NOW + 500,
                    next_sequence: next,
                    min_fill,
                    maker_bps: MAKER_BPS,
                    taker_bps: TAKER_BPS,
                    legs: fills.iter().map(|(_, q)| Leg { quantity: *q }).collect(),
                },
                participants: participants.len() as u8,
                delegations: 0,
                touched,
            }
            .data(),
        }
    }

    fn accounts(&self) -> Vec<(Pubkey, BankAccount)> {
        let mut out = vec![
            (self.config, state_account(&self.cfg)),
            (self.market_key, state_account(&self.market)),
        ];
        for (c, spec) in self.collaterals.iter().enumerate() {
            let (pool, bump) = pool_key(&self.config, &spec.mint);
            let (vault, vault_bump) = pool_vault_key(&pool);
            let liability = self.pool_liability(c);
            out.push((
                pool,
                state_account(&AssetPool {
                    config: self.config,
                    mint: spec.mint,
                    token_program: spec.program,
                    liability,
                    decimals: spec.decimals,
                    bump,
                    admitted: spec.admitted,
                    vault_bump,
                }),
            ));
            out.push((
                vault,
                if spec.program == token::ID {
                    packed(
                        RawAccount {
                            mint: spec.mint,
                            owner: pool,
                            amount: liability - spec.shortfall,
                            state: if spec.vault_frozen {
                                ClassicState::Frozen
                            } else {
                                ClassicState::Initialized
                            },
                            ..RawAccount::default()
                        },
                        token::ID,
                    )
                } else {
                    packed(
                        T22Account {
                            mint: spec.mint,
                            owner: pool,
                            amount: liability - spec.shortfall,
                            state: if spec.vault_frozen {
                                AccountState::Frozen
                            } else {
                                AccountState::Initialized
                            },
                            ..T22Account::default()
                        },
                        t22(),
                    )
                },
            ));
            out.push((
                spec.mint,
                match &spec.issuer {
                    Some(issuer) => bytes(issuer.build(), t22()),
                    None => packed(
                        RawMint {
                            mint_authority: COption::Some(user(ADMIN)),
                            supply: u64::MAX / 2,
                            decimals: spec.decimals,
                            is_initialized: true,
                            freeze_authority: COption::None,
                        },
                        token::ID,
                    ),
                },
            ));
            for branch in 0..2 {
                let asset = claim_asset(c, branch);
                out.push((
                    self.market.mints[asset],
                    packed(
                        RawMint {
                            mint_authority: COption::Some(self.market_key),
                            supply: self.supply[asset],
                            decimals: spec.decimals,
                            is_initialized: true,
                            freeze_authority: COption::None,
                        },
                        token::ID,
                    ),
                ));
                out.push((
                    claim_vault(&self.market_key, asset),
                    packed(
                        RawAccount {
                            mint: self.market.mints[asset],
                            owner: self.market_key,
                            amount: self.vault_balance(asset),
                            state: ClassicState::Initialized,
                            ..RawAccount::default()
                        },
                        token::ID,
                    ),
                ));
            }
        }
        for (owner, wallet) in &self.wallets {
            out.push((wallet_key(&self.market_key, owner).0, state_account(wallet)));
            let (trader, bump) = trader_key(&self.config, owner);
            out.push((
                trader,
                state_account(&Trader {
                    config: self.config,
                    owner: *owner,
                    minimum_nonce: 0,
                    delegation_epoch: 0,
                    bump,
                }),
            ));
        }
        for ((owner, c), available) in &self.frames {
            let pool = self.pool(*c);
            let (key, bump) = credit_key(&pool, owner);
            out.push((
                key,
                state_account(&AssetCredit {
                    pool,
                    owner: *owner,
                    available: *available,
                    bump,
                }),
            ));
        }
        for (key, order) in &self.orders {
            out.push((*key, state_account(order)));
        }
        for tag in [ADMIN, GUARDIAN, OUTSIDER].into_iter().chain(USERS) {
            out.push((user(tag), system(100_000_000_000)));
        }
        out
    }

    async fn start(&self) -> ProgramTestContext {
        assert!(
            std::env::var("BPF_OUT_DIR").is_ok(),
            "Compile the contract and set BPF_OUT_DIR"
        );
        let mut program = ProgramTest::new("conditional_stocks", ID, None);
        program.prefer_bpf(true);
        for (key, account) in self.accounts() {
            program.add_account(key, account);
        }
        let mut context = program.start_with_context().await;
        set_clock(&mut context, NOW).await;
        context
    }

    /// Compares every account the world models with the bank.
    async fn verify(&self, context: &mut ProgramTestContext, label: &str) {
        let market: Market = fetch(context, self.market_key).await;
        assert_eq!(market.credits, self.market.credits, "{label}: credits");
        assert_eq!(market.escrow, self.market.escrow, "{label}: escrow");
        assert_eq!(market.backing, self.market.backing, "{label}: backing");
        assert_eq!(market.fees, self.market.fees, "{label}: fees");
        assert_eq!(
            market.open_notional, self.market.open_notional,
            "{label}: open notional"
        );
        assert_eq!(market.sequence, self.market.sequence, "{label}: sequence");
        assert_eq!(market.bases, self.market.bases, "{label}: bases");
        for c in 0..3 {
            let (a, b) = (market.legs[c], self.market.legs[c]);
            assert_eq!(
                (a.scale, a.multiplier, a.active),
                (b.scale, b.multiplier, b.active),
                "{label}: leg {c}"
            );
        }
        assert_eq!(market.mints, self.market.mints);
        assert_eq!(market.state, self.market.state, "{label}: state");
        for (owner, expected) in &self.wallets {
            let wallet: Wallet = fetch(context, wallet_key(&self.market_key, owner).0).await;
            assert_eq!(
                wallet.balances, expected.balances,
                "{label}: wallet {owner}"
            );
            assert_eq!(
                wallet.open_notional, expected.open_notional,
                "{label}: wallet exposure {owner}"
            );
        }
        for ((owner, c), available) in &self.frames {
            let credit: AssetCredit = fetch(context, self.frame_key(owner, *c)).await;
            assert_eq!(
                credit.available, *available,
                "{label}: frame {owner} collateral {c}"
            );
        }
        for (key, expected) in &self.orders {
            let order: Order = fetch(context, *key).await;
            assert_eq!(
                (
                    order.remaining,
                    order.filled,
                    order.reserved,
                    order.open_notional,
                    order.status,
                    order.fee_carry,
                    order.sequence
                ),
                (
                    expected.remaining,
                    expected.filled,
                    expected.reserved,
                    expected.open_notional,
                    expected.status,
                    expected.fee_carry,
                    expected.sequence
                ),
                "{label}: order {key}"
            );
        }
        for c in 0..4 {
            let pool: AssetPool = fetch(context, self.pool(c)).await;
            // Pools are read-only during settlement; the recomputed liability
            // proves per-mint conservation across frames, escrow and backing.
            assert_eq!(pool.liability, self.pool_liability(c), "{label}: pool {c}");
            for branch in 0..2 {
                let asset = claim_asset(c, branch);
                assert_eq!(
                    mint_supply(context, self.market.mints[asset]).await,
                    self.supply[asset],
                    "{label}: supply {asset}"
                );
                assert_eq!(
                    token_amount(context, claim_vault(&self.market_key, asset)).await,
                    self.vault_balance(asset),
                    "{label}: claim vault {asset}"
                );
            }
        }
    }
}

async fn verify_outcome(context: &mut ProgramTestContext, outcome: &Outcome, label: &str) {
    outcome.world.verify(context, label).await;
    let (key, expected) = &outcome.taker;
    let order: Order = fetch(context, *key).await;
    assert_eq!(
        (
            order.remaining,
            order.filled,
            order.reserved,
            order.open_notional,
            order.status,
            order.fee_carry,
            order.sequence,
            order.terms.bases
        ),
        (
            expected.remaining,
            expected.filled,
            expected.reserved,
            expected.open_notional,
            expected.status,
            expected.fee_carry,
            expected.sequence,
            expected.terms.bases
        ),
        "{label}: taker order"
    );
}

/// Three resting asks from different legs and sellers:
/// 0: S1 sells 2 shares of leg 1 (NVDAx), underlying-funded;
/// 1: S2 sells 3 shares of leg 2 (classic 1.0), funded by its leg-2 claim;
/// 2: S3 sells 1.5 shares of leg 3 (NVDAon), underlying-funded.
fn three_asks(w: &mut World, branch: u8) -> [usize; 3] {
    [
        w.add_order(w.terms(S1, 101, 1, branch, 0, 0b001, 2_000_000, 180_000, 0)),
        w.add_order(w.terms(S2, 102, 1, branch, 1, 0b010, 3_000_000, 180_500, 0)),
        w.add_order(w.terms(S3, 103, 1, branch, 0, 0b100, 1_500_000, 180_900, 0)),
    ]
}

// ---------------- (a) buy taker across legs ----------------

#[tokio::test]
#[ignore = "Requires a current compiled artifact; set BPF_OUT_DIR=target/deploy and run with --ignored"]
async fn a_buy_taker_fills_asks_of_three_issuers_in_one_place() {
    for (funding, branch, separate_recipient) in
        [(0u8, 0u8, false), (1, 0, false), (0, 1, true), (1, 1, true)]
    {
        let label = format!("buy funding {funding} branch {branch} recipient {separate_recipient}");
        let mut w = World::new();
        let asks = three_asks(&mut w, branch);
        let mut terms = w.terms(T, 150, 0, branch, funding, 0b111, 5_000_000, 181_000, 0);
        if separate_recipient {
            terms.recipient = user(R);
        }
        let fills = [
            (asks[0], 2_000_000),
            (asks[1], 1_000_000),
            (asks[2], 1_500_000),
        ];
        let outcome = w.engine(user(T), &terms, &fills);
        // Reference sanity: legs deliver their own raw units at their multipliers.
        let x = 1.001701196801074f64.to_bits();
        let on = 1.0017152487959897f64.to_bits();
        assert_eq!(outcome.fills[0].1, raw(2_000_000, 100, x, false));
        assert_eq!(outcome.fills[0].1, 199_660_338);
        assert_eq!(outcome.fills[1].1, 1_000_000_000);
        assert_eq!(outcome.fills[2].1, raw(1_500_000, 1_000, on, false));
        assert!(
            outcome.fills[0].5 > 0,
            "leg-1 ask completes with a reservation surplus"
        );
        assert!(
            outcome.fills[2].5 > 0,
            "leg-3 ask completes with a reservation surplus"
        );
        assert_eq!(outcome.frames.len(), usize::from(funding == 0) + 2);
        let mut context = w.start().await;
        let ix = w.place_ix(user(T), &terms, &fills, 0b111, Some(&outcome));
        assert_eq!(
            send(&mut context, &[ix], &[&signer(T)]).await,
            Ok(()),
            "{label}"
        );
        verify_outcome(&mut context, &outcome, &label).await;
        // The buyer's recipient holds each issuer's claim separately.
        let recipient = &outcome.world.wallets[&terms.recipient];
        let b = branch as usize;
        for (c, delivered, _, fee, _, _) in &outcome.fills {
            assert_eq!(
                recipient.balances[claim_asset(*c, b)],
                HOLD + delivered - fee,
                "{label}: leg {c}"
            );
        }
        // Underlying-funded sellers receive their OWN leg's opposite claim.
        assert_eq!(
            outcome.world.wallets[&user(S1)].balances[claim_asset(1, 1 - b)],
            HOLD + outcome.fills[0].1
        );
        assert_eq!(
            outcome.world.wallets[&user(S3)].balances[claim_asset(3, 1 - b)],
            HOLD + outcome.fills[2].1
        );
        assert_eq!(
            outcome.world.wallets[&user(S1)].balances[claim_asset(3, 1 - b)],
            HOLD
        );
        // Surplus returned to the underlying-funded sellers' pool credit.
        assert_eq!(
            outcome.world.frames[&(user(S1), 1)],
            FRAME - raw(2_000_000, 100, x, true) + outcome.fills[0].5
        );
        assert_eq!(
            outcome.world.frames[&(user(S1), 1)],
            FRAME - outcome.fills[0].1
        );
        assert_eq!(
            outcome.world.frames[&(user(S3), 3)],
            FRAME - outcome.fills[2].1
        );
        // The taker rests the unfilled 0.5 share.
        assert_eq!(outcome.taker.1.remaining, 500_000);
        assert_eq!(outcome.taker.1.status, 1);
    }
}

#[tokio::test]
#[ignore = "Requires a current compiled artifact; set BPF_OUT_DIR=target/deploy and run with --ignored"]
async fn a_claim_funded_ask_surplus_and_ioc_release() {
    // An IOC buyer accepting only legs 1 and 2 completes a claim-funded ask
    // (surplus back to the claim balance) and releases the unfilled rest.
    let mut w = World::new();
    let x = w.add_order(w.terms(S1, 101, 1, 0, 1, 0b001, 1_000_000, 180_000, 0));
    let y = w.add_order(w.terms(S2, 102, 1, 0, 0, 0b010, 1_000_000, 180_000, 0));
    let terms = w.terms(T, 150, 0, 0, 0, 0b011, 3_000_000, 180_000, 1);
    let fills = [(x, 1_000_000), (y, 1_000_000)];
    let outcome = w.engine(user(T), &terms, &fills);
    assert!(outcome.fills[0].5 > 0);
    assert_eq!(outcome.fills[1].5, 0, "multiplier 1.0 leaves no surplus");
    assert_eq!(outcome.taker.1.status, 3);
    let mut context = w.start().await;
    let ix = w.place_ix(user(T), &terms, &fills, 0b011, Some(&outcome));
    assert_eq!(send(&mut context, &[ix], &[&signer(T)]).await, Ok(()));
    verify_outcome(&mut context, &outcome, "ioc").await;
    // S1's leg-1 YES claim: reserved ceil, delivered floor, surplus refunded.
    assert_eq!(
        outcome.world.wallets[&user(S1)].balances[claim_asset(1, 0)],
        HOLD - outcome.fills[0].1
    );
}

// ---------------- (b) sell taker against bids ----------------

#[tokio::test]
#[ignore = "Requires a current compiled artifact; set BPF_OUT_DIR=target/deploy and run with --ignored"]
async fn b_sell_taker_fills_only_bids_accepting_its_leg() {
    let mut w = World::new();
    let only_leg2 = w.add_order(w.terms(B1, 111, 0, 0, 0, 0b010, 1_000_000, 180_300, 0));
    let legs13 = w.add_order(w.terms(B2, 112, 0, 0, 0, 0b101, 1_000_000, 180_200, 0));
    let all = w.add_order(w.terms(B3, 113, 0, 0, 1, 0b111, 1_000_000, 180_100, 0));
    let terms = w.terms(T, 150, 1, 0, 0, 0b001, 1_000_000, 179_000, 0);
    // A bid that does not accept leg 1 is a stale plan.
    for fills in [
        vec![(only_leg2, 500_000)],
        vec![(legs13, 500_000), (only_leg2, 500_000)],
    ] {
        let mut context = w.start().await;
        let ix = w.place_ix(user(T), &terms, &fills, 0b001, None);
        assert_eq!(
            send(&mut context, &[ix], &[&signer(T)]).await,
            Err(code(ProtocolError::StalePlan))
        );
    }
    // Bids accepting leg 1 fill; the completed taker ask refunds its surplus.
    let fills = [(legs13, 600_000), (all, 400_000)];
    let outcome = w.engine(user(T), &terms, &fills);
    assert_eq!(outcome.taker.1.status, 2);
    let x = 1.001701196801074f64.to_bits();
    let delivered = raw(600_000, 100, x, false) + raw(400_000, 100, x, false);
    assert_eq!(outcome.fills[0].1 + outcome.fills[1].1, delivered);
    assert_eq!(outcome.world.frames[&(user(T), 1)], FRAME - delivered);
    let mut context = w.start().await;
    let ix = w.place_ix(user(T), &terms, &fills, 0b001, Some(&outcome));
    assert_eq!(send(&mut context, &[ix], &[&signer(T)]).await, Ok(()));
    verify_outcome(&mut context, &outcome, "sell taker").await;
    // The underlying-funded taker seller receives leg-1 NO; B2/B3 receive leg-1 YES.
    assert_eq!(
        outcome.world.wallets[&user(T)].balances[claim_asset(1, 1)],
        HOLD + delivered
    );
    // A resting sell of leg 1 with no fills still names its leg in `touched`.
    let rest = w.terms(T, 151, 1, 0, 0, 0b001, 1_000_000, 190_000, 0);
    let outcome = w.engine(user(T), &rest, &[]);
    assert_eq!(
        outcome.taker.1.reserved,
        raw(1_000_000, 100, x, true),
        "reservation rounds up at the live multiplier"
    );
    let mut context = w.start().await;
    let ix = w.place_ix(user(T), &rest, &[], 0b001, Some(&outcome));
    assert_eq!(send(&mut context, &[ix], &[&signer(T)]).await, Ok(()));
    verify_outcome(&mut context, &outcome, "resting sell").await;
    let mut context = w.start().await;
    let ix = w.place_ix(user(T), &rest, &[], 0, Some(&outcome));
    assert_eq!(
        send(&mut context, &[ix], &[&signer(T)]).await,
        Err(code(ProtocolError::InvalidAccount)),
        "resting sell without its leg"
    );
}

// ---------------- (c) account validation ----------------

#[tokio::test]
#[ignore = "Requires a current compiled artifact; set BPF_OUT_DIR=target/deploy and run with --ignored"]
async fn c_touched_legs_and_leg_accounts_are_exact() {
    let mut w = World::new();
    let asks = three_asks(&mut w, 0);
    let terms = w.terms(T, 150, 0, 0, 0, 0b111, 2_000_000, 181_000, 0);
    let fills = [(asks[0], 1_000_000), (asks[2], 1_000_000)];
    let outcome = w.engine(user(T), &terms, &fills);
    let good = w.place_ix(user(T), &terms, &fills, 0b101, Some(&outcome));
    let mut context = w.start().await;
    let s = signer(T);
    // A leg that a fill delivers must be touched (an extra touched leg, e.g.
    // of a maker skipped as stale, is allowed).
    for touched in [0b001u8, 0b100, 0b011, 0] {
        let ix = w.place_ix(user(T), &terms, &fills, touched, Some(&outcome));
        assert_eq!(
            send(&mut context, &[ix], &[&s]).await,
            Err(code(ProtocolError::InvalidAccount)),
            "touched {touched:#b}"
        );
    }
    // An unlisted leg bit.
    let mut two_legs = w.clone();
    two_legs.market.bases = 2;
    let mut ctx2 = two_legs.start().await;
    let ix = two_legs.place_ix(
        user(T),
        &w.terms(T, 150, 0, 0, 0, 0b011, 2_000_000, 181_000, 0),
        &[],
        0b100,
        None,
    );
    assert_eq!(
        send(&mut ctx2, &[ix], &[&s]).await,
        Err(code(ProtocolError::InvalidTerms))
    );
    let ix = two_legs.place_ix(
        user(T),
        &w.terms(T, 150, 0, 0, 0, 0b111, 2_000_000, 181_000, 0),
        &[],
        0,
        None,
    );
    assert_eq!(
        send(&mut ctx2, &[ix], &[&s]).await,
        Err(code(ProtocolError::InvalidTerms)),
        "bases beyond listed legs"
    );
    // Leg slots start after the 10 named accounts and 4 quote-claim accounts.
    let leg1 = 10 + 4;
    let leg3 = leg1 + 7;
    // Single-leg placement (leg 1 only) so substitutes are not duplicates.
    let single = [(asks[0], 1_000_000)];
    let single_outcome = w.engine(user(T), &terms, &single);
    let good1 = w.place_ix(user(T), &terms, &single, 0b001, Some(&single_outcome));
    let replace = |base: &Instruction, index: usize, key: Pubkey| {
        let mut ix = base.clone();
        ix.accounts[index].pubkey = key;
        ix
    };
    let cases = [
        (
            "leg-2 pool in leg-1 slot",
            replace(&good1, leg1, w.pool(2)),
            ProtocolError::InvalidAccount,
        ),
        (
            "quote pool in leg-1 slot",
            replace(&good1, leg1, w.pool(0)),
            ProtocolError::InvalidAccount,
        ),
        (
            "leg-3 vault in leg-1 slot",
            replace(&good1, leg1 + 1, pool_vault_key(&w.pool(3)).0),
            ProtocolError::InvalidAccount,
        ),
        (
            "leg-3 mint in leg-1 slot",
            replace(&good1, leg1 + 2, w.collaterals[3].mint),
            ProtocolError::InvalidAsset,
        ),
        (
            "leg-3 YES claim mint in leg-1 slot",
            replace(&good1, leg1 + 3, w.market.mints[claim_asset(3, 0)]),
            ProtocolError::InvalidAsset,
        ),
        (
            "leg-3 YES vault in leg-1 slot",
            replace(
                &good1,
                leg1 + 4,
                claim_vault(&w.market_key, claim_asset(3, 0)),
            ),
            ProtocolError::InvalidAccount,
        ),
        (
            "leg-1 NO vault as YES vault (duplicate)",
            replace(
                &good1,
                leg1 + 4,
                claim_vault(&w.market_key, claim_asset(1, 1)),
            ),
            ProtocolError::InvalidAccount,
        ),
        (
            "quote pool in leg-3 slot",
            replace(&good, leg3, w.pool(0)),
            ProtocolError::InvalidAccount,
        ),
        (
            "leg-1 pool in leg-3 slot (duplicate)",
            replace(&good, leg3, w.pool(1)),
            ProtocolError::InvalidAccount,
        ),
        (
            "leg-1 mint in leg-3 slot (duplicate)",
            replace(&good, leg3 + 2, w.collaterals[1].mint),
            ProtocolError::InvalidAccount,
        ),
    ];
    for (label, ix, expected) in cases {
        assert_eq!(
            send(&mut context, &[ix], &[&s]).await,
            Err(code(expected)),
            "{label}"
        );
    }
    // Duplicate maker order across two plan legs.
    let dup = w.place_ix(
        user(T),
        &terms,
        &[(asks[0], 1_000_000), (asks[0], 1_000_000)],
        0b001,
        None,
    );
    assert_eq!(
        send(&mut context, &[dup], &[&s]).await,
        Err(code(ProtocolError::InvalidAccount))
    );
    // A duplicated credit frame.
    let mut ix = good.clone();
    let frame = ix.accounts.last().unwrap().clone();
    ix.accounts.push(frame);
    assert_eq!(
        send(&mut context, &[ix], &[&s]).await,
        Err(code(ProtocolError::InvalidAccount))
    );
    // The correct placement still succeeds afterwards (nothing was mutated).
    assert_eq!(send(&mut context, &[good], &[&s]).await, Ok(()));
    verify_outcome(&mut context, &outcome, "after rejected variants").await;
}

// ---------------- (d) halts ----------------

/// Mutates a world so that leg 1 is halted.
type Halt = Box<dyn Fn(&mut World)>;

#[tokio::test]
#[ignore = "Requires a current compiled artifact; set BPF_OUT_DIR=target/deploy and run with --ignored"]
async fn d_paused_frozen_or_split_legs_halt_new_exposure_only_on_that_leg() {
    let listing = 1.001701196801074f64.to_bits();
    let halts: Vec<(&str, Halt)> = vec![
        (
            "paused",
            Box::new(|w: &mut World| {
                let issuer = w.issuer_mut(1).clone().paused(true);
                *w.issuer_mut(1) = issuer;
            }),
        ),
        (
            "2-for-1 split effective",
            Box::new(move |w: &mut World| {
                let issuer = w.issuer_mut(1).clone().scaled(
                    listing,
                    NOW - 1,
                    (2.0 * f64::from_bits(listing)).to_bits(),
                );
                *w.issuer_mut(1) = issuer;
            }),
        ),
        (
            "reverse split effective",
            Box::new(move |w: &mut World| {
                let issuer = w.issuer_mut(1).clone().scaled(
                    listing,
                    NOW,
                    (0.1 * f64::from_bits(listing)).to_bits(),
                );
                *w.issuer_mut(1) = issuer;
            }),
        ),
        (
            "frozen pool vault",
            Box::new(|w: &mut World| w.collaterals[1].vault_frozen = true),
        ),
    ];
    for (label, halt) in halts {
        let mut w = World::new();
        let asks = three_asks(&mut w, 0);
        halt(&mut w);
        let mut context = w.start().await;
        let s = signer(T);
        // Filling the halted leg fails, alone or with another leg.
        let buy = w.terms(T, 150, 0, 0, 0, 0b111, 3_000_000, 181_000, 0);
        for (fills, touched) in [
            (vec![(asks[0], 1_000_000)], 0b001u8),
            (vec![(asks[1], 1_000_000), (asks[0], 1_000_000)], 0b011),
        ] {
            let ix = w.place_ix(user(T), &buy, &fills, touched, None);
            assert_eq!(
                send(&mut context, &[ix], &[&s]).await,
                Err(code(ProtocolError::LegHalted)),
                "{label}"
            );
        }
        // A new ask of the halted leg cannot rest either.
        let sell = w.terms(T, 151, 1, 0, 0, 0b001, 1_000_000, 190_000, 0);
        let ix = w.place_ix(user(T), &sell, &[], 0b001, None);
        assert_eq!(
            send(&mut context, &[ix], &[&s]).await,
            Err(code(ProtocolError::LegHalted)),
            "{label}"
        );
        // Other legs keep trading with the same multi-leg bid.
        let fills = [(asks[1], 1_000_000), (asks[2], 1_000_000)];
        let outcome = w.engine(user(T), &buy, &fills);
        let ix = w.place_ix(user(T), &buy, &fills, 0b110, Some(&outcome));
        assert_eq!(send(&mut context, &[ix], &[&s]).await, Ok(()), "{label}");
        verify_outcome(&mut context, &outcome, label).await;
    }
    // A split announced for the future is not effective yet: trading continues
    // at the listing multiplier.
    let mut w = World::new();
    let asks = three_asks(&mut w, 0);
    let issuer =
        w.issuer_mut(1)
            .clone()
            .scaled(listing, NOW + 1, (2.0 * f64::from_bits(listing)).to_bits());
    *w.issuer_mut(1) = issuer;
    let buy = w.terms(T, 150, 0, 0, 0, 0b001, 2_000_000, 181_000, 0);
    let fills = [(asks[0], 2_000_000)];
    let outcome = w.engine(user(T), &buy, &fills);
    assert_eq!(outcome.fills[0].1, 199_660_338);
    let mut context = w.start().await;
    let ix = w.place_ix(user(T), &buy, &fills, 0b001, Some(&outcome));
    assert_eq!(send(&mut context, &[ix], &[&signer(T)]).await, Ok(()));
    verify_outcome(&mut context, &outcome, "pending split").await;
}

/// Exact band membership of `current` against `listing` (4/5..=5/4).
fn in_band(listing: u64, current: u64) -> bool {
    let (ln, lk) = ratio(listing);
    let (cn, ck) = ratio(current);
    // current / listing = cn * 2^lk / (ln * 2^ck)
    let (lhs, rhs) = (cn << lk, ln << ck);
    4 * lhs <= 5 * rhs && 5 * lhs >= 4 * rhs
}
/// The outermost multiplier bits still inside the band, above or below.
fn band_edge(listing: u64, upper: bool) -> u64 {
    let mut bits = (f64::from_bits(listing) * if upper { 1.25 } else { 0.8 }).to_bits();
    let step = |b: u64, out: bool| if upper == out { b + 1 } else { b - 1 };
    while !in_band(listing, bits) {
        bits = step(bits, false);
    }
    while in_band(listing, step(bits, true)) {
        bits = step(bits, true);
    }
    bits
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Expect {
    /// Fills convert at the live multiplier; new asks reserve at it.
    Fill,
    /// Outside the band: fills and new asks are LegHalted.
    Halt,
    /// Inside the band but below the listing multiplier: an ask reserved at
    /// the higher multiplier cannot cover the live delivery (StalePlan, which
    /// the SDK planner avoids by skipping it), while new asks may rest.
    Uncovered,
}

#[tokio::test]
#[ignore = "Requires a current compiled artifact; set BPF_OUT_DIR=target/deploy and run with --ignored"]
async fn d_dividend_band_edges_and_live_multiplier_conversion() {
    let listing = World::new().market.legs[0].multiplier;
    let up = band_edge(listing, true);
    let down = band_edge(listing, false);
    assert!(in_band(listing, up) && !in_band(listing, up + 1));
    assert!(in_band(listing, down) && !in_band(listing, down - 1));
    assert_eq!(protocol_core::within_band(listing, up), Ok(true));
    assert_eq!(protocol_core::within_band(listing, up + 1), Ok(false));
    assert_eq!(protocol_core::within_band(listing, down), Ok(true));
    assert_eq!(protocol_core::within_band(listing, down - 1), Ok(false));
    let x = f64::from_bits(listing);
    for (label, live, expect) in [
        ("x1.2", (x * 1.2).to_bits(), Expect::Fill),
        ("upper edge", up, Expect::Fill),
        ("above band", up + 1, Expect::Halt),
        ("x0.9", (x * 0.9).to_bits(), Expect::Uncovered),
        ("lower edge", down, Expect::Uncovered),
        ("below band", down - 1, Expect::Halt),
    ] {
        let mut w = World::new();
        let asks = three_asks(&mut w, 0);
        let issuer = w.issuer_mut(1).clone().scaled(listing, NOW - 100, live);
        *w.issuer_mut(1) = issuer;
        assert_eq!(w.live(1), live);
        let mut context = w.start().await;
        let buy = w.terms(T, 150, 0, 0, 0, 0b001, 2_000_000, 181_000, 0);
        let fills = [(asks[0], 2_000_000)];
        let sell = w.terms(S1, 160, 1, 0, 0, 0b001, 1_000_000, 190_000, 0);
        match expect {
            Expect::Halt => {
                let ix = w.place_ix(user(T), &buy, &fills, 0b001, None);
                assert_eq!(
                    send(&mut context, &[ix], &[&signer(T)]).await,
                    Err(code(ProtocolError::LegHalted)),
                    "{label}"
                );
                let ix = w.place_ix(user(S1), &sell, &[], 0b001, None);
                assert_eq!(
                    send(&mut context, &[ix], &[&signer(S1)]).await,
                    Err(code(ProtocolError::LegHalted)),
                    "{label}"
                );
            }
            Expect::Uncovered => {
                assert!(raw(2_000_000, 100, live, false) > raw(2_000_000, 100, listing, true));
                // The ask can no longer deliver: it is skipped and the buy rests.
                let unfilled = w.engine(user(T), &buy, &[]);
                let ix = w.place_ix(user(T), &buy, &fills, 0b001, Some(&unfilled));
                assert_eq!(
                    send(&mut context, &[ix], &[&signer(T)]).await,
                    Ok(()),
                    "{label}"
                );
                verify_outcome(&mut context, &unfilled, label).await;
                let mut context = w.start().await;
                let resting = w.engine(user(S1), &sell, &[]);
                assert_eq!(resting.taker.1.reserved, raw(1_000_000, 100, live, true));
                let ix = w.place_ix(user(S1), &sell, &[], 0b001, Some(&resting));
                assert_eq!(
                    send(&mut context, &[ix], &[&signer(S1)]).await,
                    Ok(()),
                    "{label}"
                );
                verify_outcome(&mut context, &resting, label).await;
            }
            Expect::Fill => {
                let outcome = w.engine(user(T), &buy, &fills);
                assert_eq!(outcome.fills[0].1, raw(2_000_000, 100, live, false));
                // Reserved at the listing multiplier, delivered at the live one:
                // the completed ask returns the difference to the seller.
                assert_eq!(
                    outcome.fills[0].5,
                    raw(2_000_000, 100, listing, true) - raw(2_000_000, 100, live, false)
                );
                let ix = w.place_ix(user(T), &buy, &fills, 0b001, Some(&outcome));
                assert_eq!(
                    send(&mut context, &[ix], &[&signer(T)]).await,
                    Ok(()),
                    "{label}"
                );
                verify_outcome(&mut context, &outcome, label).await;
                let mut after = outcome.world.clone();
                after.orders.push(outcome.taker.clone());
                let resting = after.engine(user(S1), &sell, &[]);
                assert_eq!(resting.taker.1.reserved, raw(1_000_000, 100, live, true));
                let ix = after.place_ix(user(S1), &sell, &[], 0b001, Some(&resting));
                assert_eq!(
                    send(&mut context, &[ix], &[&signer(S1)]).await,
                    Ok(()),
                    "{label}"
                );
                verify_outcome(&mut context, &resting, &format!("{label} resting ask")).await;
            }
        }
    }
}

#[tokio::test]
#[ignore = "Requires a current compiled artifact; set BPF_OUT_DIR=target/deploy and run with --ignored"]
async fn d_seized_or_hooked_leg_fails_closed_and_is_isolated() {
    // A PermanentDelegate seizure of one raw unit from the leg-1 pool vault,
    // or a transfer hook configured after listing, blocks every path that
    // touches leg 1 while legs 2 and 3 keep trading.
    for (label, expected) in [
        ("seized", ProtocolError::Insolvent),
        ("hooked", ProtocolError::TransferHookEnabled),
    ] {
        let mut w = World::new();
        let asks = three_asks(&mut w, 0);
        if label == "seized" {
            w.collaterals[1].shortfall = 1;
        } else {
            let issuer = w.issuer_mut(1).clone().hook(Some(Pubkey::new_unique()));
            *w.issuer_mut(1) = issuer;
        }
        let mut context = w.start().await;
        let buy = w.terms(T, 150, 0, 0, 0, 0b111, 3_000_000, 181_000, 0);
        let ix = w.place_ix(user(T), &buy, &[(asks[0], 1_000_000)], 0b001, None);
        assert_eq!(
            send(&mut context, &[ix], &[&signer(T)]).await,
            Err(code(expected)),
            "{label} fill"
        );
        let sell = w.terms(S1, 160, 1, 0, 0, 0b001, 1_000_000, 190_000, 0);
        let ix = w.place_ix(user(S1), &sell, &[], 0b001, None);
        assert_eq!(
            send(&mut context, &[ix], &[&signer(S1)]).await,
            Err(code(expected)),
            "{label} ask"
        );
        let split = positions_ix(
            &w.config,
            &w.market_key,
            &w.market,
            user(S1),
            1,
            instruction::Split {
                collateral: 1,
                amount: 10,
            }
            .data(),
        );
        assert_eq!(
            send(&mut context, &[split], &[&signer(S1)]).await,
            Err(code(expected)),
            "{label} split"
        );
        let fills = [(asks[1], 1_000_000), (asks[2], 1_000_000)];
        let outcome = w.engine(user(T), &buy, &fills);
        let ix = w.place_ix(user(T), &buy, &fills, 0b110, Some(&outcome));
        assert_eq!(
            send(&mut context, &[ix], &[&signer(T)]).await,
            Ok(()),
            "{label} other legs"
        );
        verify_outcome(&mut context, &outcome, label).await;
    }
}

#[tokio::test]
#[ignore = "Requires a current compiled artifact; set BPF_OUT_DIR=target/deploy and run with --ignored"]
async fn d_delisted_leg_halts_fills_and_asks_but_releases_publicly() {
    let mut w = World::new();
    let asks = three_asks(&mut w, 0);
    let mut context = w.start().await;
    let (config, market_key) = (w.config, w.market_key);
    let set_base = |actor: u8, c: u8, active: bool| Instruction {
        program_id: ID,
        accounts: accounts::SetBase {
            actor: user(actor),
            config,
            market: market_key,
        }
        .to_account_metas(None),
        data: instruction::SetBase {
            collateral: c,
            active,
        }
        .data(),
    };
    // Roles: outsiders cannot delist; the guardian delists; only the admin relists.
    assert_eq!(
        send(
            &mut context,
            &[set_base(OUTSIDER, 1, false)],
            &[&signer(OUTSIDER)]
        )
        .await,
        Err(code(ProtocolError::Unauthorized))
    );
    assert_eq!(
        send(
            &mut context,
            &[set_base(GUARDIAN, 1, false)],
            &[&signer(GUARDIAN)]
        )
        .await,
        Ok(())
    );
    assert_eq!(
        send(
            &mut context,
            &[set_base(GUARDIAN, 1, true)],
            &[&signer(GUARDIAN)]
        )
        .await,
        Err(code(ProtocolError::Unauthorized))
    );
    assert_eq!(
        send(
            &mut context,
            &[set_base(ADMIN, 1, false)],
            &[&signer(ADMIN)]
        )
        .await,
        Err(code(ProtocolError::InvalidState)),
        "already delisted"
    );
    for c in [0u8, 4, 9] {
        assert_eq!(
            send(
                &mut context,
                &[set_base(ADMIN, c, false)],
                &[&signer(ADMIN)]
            )
            .await,
            Err(code(ProtocolError::InvalidAsset)),
            "collateral {c}"
        );
    }
    w.market.legs[0].active = false;
    w.verify(&mut context, "delisted").await;
    let s = signer(T);
    let buy = w.terms(T, 150, 0, 0, 0, 0b111, 3_000_000, 181_000, 0);
    let ix = w.place_ix(user(T), &buy, &[(asks[0], 1_000_000)], 0b001, None);
    assert_eq!(
        send(&mut context, &[ix], &[&s]).await,
        Err(code(ProtocolError::LegHalted))
    );
    let sell = w.terms(T, 151, 1, 0, 1, 0b001, 1_000_000, 190_000, 0);
    let ix = w.place_ix(user(T), &sell, &[], 0b001, None);
    assert_eq!(
        send(&mut context, &[ix], &[&s]).await,
        Err(code(ProtocolError::LegHalted))
    );
    // Bids accepting the delisted leg still trade the other legs.
    let fills = [(asks[1], 2_000_000), (asks[2], 500_000)];
    let outcome = w.engine(user(T), &buy, &fills);
    let ix = w.place_ix(user(T), &buy, &fills, 0b110, Some(&outcome));
    assert_eq!(send(&mut context, &[ix], &[&s]).await, Ok(()));
    verify_outcome(&mut context, &outcome, "other legs").await;
    let mut w = outcome.world;
    w.orders.push(outcome.taker);
    // Anyone can release the delisted leg's resting ask; its reservation
    // returns to the seller's pool credit.
    let cancel = |w: &World, actor: u8, index: usize, frame: Option<Pubkey>| {
        let (key, order) = &w.orders[index];
        let mut metas = accounts::Cancel {
            actor: user(actor),
            market: w.market_key,
            order: *key,
            wallet: wallet_key(&w.market_key, &order.owner).0,
            trader: trader_key(&w.config, &order.owner).0,
            delegation: None,
        }
        .to_account_metas(None);
        if let Some(frame) = frame {
            metas.push(AccountMeta::new(frame, false));
        }
        Instruction {
            program_id: ID,
            accounts: metas,
            data: instruction::Cancel {}.data(),
        }
    };
    // An ask of a listed leg is not publicly releasable.
    let ix = cancel(&w, OUTSIDER, asks[1], None);
    assert_eq!(
        send(&mut context, &[ix], &[&signer(OUTSIDER)]).await,
        Err(code(ProtocolError::Unauthorized))
    );
    let frame = w.frame_key(&user(S1), 1);
    let ix = cancel(&w, OUTSIDER, asks[0], Some(frame));
    assert_eq!(
        send(&mut context, &[ix], &[&signer(OUTSIDER)]).await,
        Ok(())
    );
    let (_, order) = &mut w.orders[asks[0]];
    let (reserved, notional) = (order.reserved, order.open_notional);
    order.remaining = 0;
    order.reserved = 0;
    order.open_notional = 0;
    order.status = 3;
    w.market.escrow[3] -= reserved as u128;
    *w.frames.get_mut(&(user(S1), 1)).unwrap() += reserved;
    w.exposure(&user(S1), 0, notional);
    w.verify(&mut context, "public release").await;
    assert_eq!(w.frames[&(user(S1), 1)], FRAME);
    // Relisting by the admin restores trading of the leg.
    assert_eq!(
        send(&mut context, &[set_base(ADMIN, 1, true)], &[&signer(ADMIN)]).await,
        Ok(())
    );
    w.market.legs[0].active = true;
    let sell = w.terms(S1, 170, 1, 0, 0, 0b001, 1_000_000, 190_000, 0);
    let outcome = w.engine(user(S1), &sell, &[]);
    let ix = w.place_ix(user(S1), &sell, &[], 0b001, Some(&outcome));
    assert_eq!(send(&mut context, &[ix], &[&signer(S1)]).await, Ok(()));
    verify_outcome(&mut context, &outcome, "relisted").await;
}

// ---------------- (f) positions on a leg with a multiplier ----------------

#[tokio::test]
#[ignore = "Requires a current compiled artifact; set BPF_OUT_DIR=target/deploy and run with --ignored"]
async fn f_split_merge_redeem_use_raw_units_and_split_halts_with_the_leg() {
    for halted in [
        None,
        Some("paused"),
        Some("split"),
        Some("frozen"),
        Some("delisted"),
    ] {
        let mut w = World::new();
        match halted {
            Some("paused") => {
                let issuer = w.issuer_mut(1).clone().paused(true);
                *w.issuer_mut(1) = issuer;
            }
            Some("split") => {
                let listing = w.market.legs[0].multiplier;
                let issuer = w.issuer_mut(1).clone().scaled(
                    listing,
                    0,
                    (f64::from_bits(listing) * 3.0).to_bits(),
                );
                *w.issuer_mut(1) = issuer;
            }
            Some("frozen") => w.collaterals[1].vault_frozen = true,
            Some("delisted") => w.market.legs[0].active = false,
            _ => {}
        }
        let label = format!("{halted:?}");
        let mut context = w.start().await;
        let owner = user(S1);
        let s = signer(S1);
        let split = |amount| {
            positions_ix(
                &w.config,
                &w.market_key,
                &w.market,
                owner,
                1,
                instruction::Split {
                    collateral: 1,
                    amount,
                }
                .data(),
            )
        };
        let merge = |amount| {
            positions_ix(
                &w.config,
                &w.market_key,
                &w.market,
                owner,
                1,
                instruction::Merge {
                    collateral: 1,
                    amount,
                }
                .data(),
            )
        };
        let mut expected = w.clone();
        if halted.is_some() {
            assert_eq!(
                send(&mut context, &[split(1_234_567)], &[&s]).await,
                Err(code(ProtocolError::LegHalted)),
                "{label}"
            );
        } else {
            // 1 234 567 raw NVDAx units (not share units): exact, no conversion.
            assert_eq!(send(&mut context, &[split(1_234_567)], &[&s]).await, Ok(()));
            expected.debit(&owner, 3, 1_234_567);
            expected.market.backing[1] += 1_234_567;
            for branch in 0..2 {
                expected.credit(&owner, claim_asset(1, branch), 1_234_567);
                expected.supply[claim_asset(1, branch)] += 1_234_567;
            }
            expected.verify(&mut context, &label).await;
        }
        // Merge (and redeem later) never create exposure: always available.
        assert_eq!(
            send(&mut context, &[merge(1_000_001)], &[&s]).await,
            Ok(()),
            "{label}"
        );
        expected.credit(&owner, 3, 1_000_001);
        expected.market.backing[1] -= 1_000_001;
        for branch in 0..2 {
            expected.debit(&owner, claim_asset(1, branch), 1_000_001);
            expected.supply[claim_asset(1, branch)] -= 1_000_001;
        }
        expected
            .verify(&mut context, &format!("{label} merge"))
            .await;
        // Other legs are unaffected by leg 1's halt.
        let split3 = positions_ix(
            &w.config,
            &w.market_key,
            &w.market,
            owner,
            3,
            instruction::Split {
                collateral: 3,
                amount: 777,
            }
            .data(),
        );
        assert_eq!(
            send(&mut context, &[split3], &[&s]).await,
            Ok(()),
            "{label} leg 3"
        );
        // Wrong underlying mint for the leg.
        let mut ix = split(5);
        ix.accounts[11].pubkey = w.collaterals[3].mint;
        assert!(send(&mut context, &[ix], &[&s]).await.is_err());
    }
    // Redemption after resolution, per leg, in raw units.
    let mut w = World::new();
    w.market.state = protocol_core::REDEEMABLE;
    w.market.payouts = [1, 0];
    let issuer = w.issuer_mut(1).clone().paused(true);
    *w.issuer_mut(1) = issuer; // even while the issuer is paused
    let mut context = w.start().await;
    let owner = user(S2);
    let redeem = |c: usize, yes, no| {
        positions_ix(
            &w.config,
            &w.market_key,
            &w.market,
            owner,
            c,
            instruction::Redeem {
                collateral: c as u8,
                yes_amount: yes,
                no_amount: no,
            }
            .data(),
        )
    };
    assert_eq!(
        send(&mut context, &[redeem(1, 3_333_333, 5)], &[&signer(S2)]).await,
        Ok(())
    );
    assert_eq!(
        send(&mut context, &[redeem(3, 7, 0)], &[&signer(S2)]).await,
        Ok(())
    );
    let mut expected = w.clone();
    for (c, yes, no) in [(1usize, 3_333_333u64, 5u64), (3, 7, 0)] {
        expected.debit(&owner, claim_asset(c, 0), yes);
        expected.debit(&owner, claim_asset(c, 1), no);
        expected.supply[claim_asset(c, 0)] -= yes;
        expected.supply[claim_asset(c, 1)] -= no;
        expected.market.backing[c] -= yes;
        expected.credit(&owner, 3 * c, yes);
    }
    expected.verify(&mut context, "redeem").await;
}

// ---------------- (e) listing and admission end to end ----------------

struct Chain {
    context: ProgramTestContext,
    config: Pubkey,
    market: Pubkey,
    quote: Pubkey,
}

fn issuer_with_authority(mut issuer: Issuer, authority: Pubkey) -> Issuer {
    issuer.mint_authority = Some(authority);
    issuer.supply = 0;
    issuer
}

fn initialize_pool_ix(
    payer: Pubkey,
    config: Pubkey,
    mint: Pubkey,
    program: Pubkey,
    admitted: u16,
) -> Instruction {
    let (pool, _) = pool_key(&config, &mint);
    Instruction {
        program_id: ID,
        accounts: accounts::InitializePool {
            payer,
            config,
            mint,
            pool,
            vault: pool_vault_key(&pool).0,
            token_program: program,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::InitializePool { admitted }.data(),
    }
}

fn add_base_ix(
    admin: Pubkey,
    config: Pubkey,
    market: Pubkey,
    mint: Pubkey,
    program: Pubkey,
) -> Instruction {
    let (pool, _) = pool_key(&config, &mint);
    Instruction {
        program_id: ID,
        accounts: accounts::AddBase {
            admin,
            config,
            market,
            mint,
            pool,
            vault: pool_vault_key(&pool).0,
            token_program: program,
        }
        .to_account_metas(None),
        data: instruction::AddBase {}.data(),
    }
}

fn initialize_claims_ix(payer: Pubkey, market: Pubkey, c: u8) -> Instruction {
    let asset = |branch: u8| (3u8.saturating_mul(c)).saturating_add(1 + branch) as usize;
    Instruction {
        program_id: ID,
        accounts: accounts::InitializeClaims {
            payer,
            market,
            yes_mint: claim_mint(&market, asset(0)),
            no_mint: claim_mint(&market, asset(1)),
            yes_vault: claim_vault(&market, asset(0)),
            no_vault: claim_vault(&market, asset(1)),
            token_program: token::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::InitializeClaims { collateral: c }.data(),
    }
}

fn lifecycle_ix(actor: Pubkey, config: Pubkey, market: Pubkey, action: u8) -> Instruction {
    Instruction {
        program_id: ID,
        accounts: accounts::Lifecycle {
            actor,
            config,
            market,
        }
        .to_account_metas(None),
        data: instruction::Lifecycle {
            action,
            commitment: [0; 32],
        }
        .data(),
    }
}

/// A user token account for a (possibly Token-2022) mint, with the account
/// extensions the mint requires, funded by `mint_to` from the admin.
async fn funded_token_account(
    context: &mut ProgramTestContext,
    program: Pubkey,
    mint: Pubkey,
    owner: &Keypair,
    amount: u64,
) -> Pubkey {
    use anchor_spl::token_2022::spl_token_2022::instruction as t22ix;
    let account = Keypair::new();
    let mint_data = raw_account(context, mint).await.data;
    let len = if program == t22() {
        let kinds = StateWithExtensions::<T22Mint>::unpack(&mint_data)
            .unwrap()
            .get_extension_types()
            .unwrap();
        ExtensionType::try_calculate_account_len::<T22Account>(
            &ExtensionType::get_required_init_account_extensions(&kinds),
        )
        .unwrap()
    } else {
        RawAccount::LEN
    };
    // SystemInstruction::CreateAccount { lamports, space, owner } (bincode).
    let mut data = 0u32.to_le_bytes().to_vec();
    data.extend_from_slice(&Rent::default().minimum_balance(len).to_le_bytes());
    data.extend_from_slice(&(len as u64).to_le_bytes());
    data.extend_from_slice(program.as_ref());
    let create = Instruction {
        program_id: anchor_lang::system_program::ID,
        accounts: vec![
            AccountMeta::new(owner.pubkey(), true),
            AccountMeta::new(account.pubkey(), true),
        ],
        data,
    };
    let init =
        t22ix::initialize_account3(&program, &account.pubkey(), &mint, &owner.pubkey()).unwrap();
    let mint_to = t22ix::mint_to(
        &program,
        &mint,
        &account.pubkey(),
        &user(ADMIN),
        &[],
        amount,
    )
    .unwrap();
    assert_eq!(
        send(context, &[create, init], &[owner, &account]).await,
        Ok(())
    );
    assert_eq!(send(context, &[mint_to], &[&signer(ADMIN)]).await, Ok(()));
    account.pubkey()
}

async fn chain() -> (Chain, BTreeMap<&'static str, (Pubkey, Pubkey, Issuer)>) {
    assert!(
        std::env::var("BPF_OUT_DIR").is_ok(),
        "Compile the contract and set BPF_OUT_DIR"
    );
    let admin = user(ADMIN);
    let mut program = ProgramTest::new("conditional_stocks", ID, None);
    program.prefer_bpf(true);
    for tag in [ADMIN, GUARDIAN, OUTSIDER].into_iter().chain(USERS) {
        program.add_account(user(tag), system(100_000_000_000));
    }
    let quote = Pubkey::new_from_array([210; 32]);
    program.add_account(
        quote,
        packed(
            RawMint {
                mint_authority: COption::Some(admin),
                supply: 0,
                decimals: 6,
                is_initialized: true,
                freeze_authority: COption::None,
            },
            token::ID,
        ),
    );
    let classic = |decimals: u8| Issuer {
        decimals,
        mint_authority: Some(admin),
        supply: 0,
        freeze_authority: None,
        extensions: vec![],
    };
    let mut mints = BTreeMap::new();
    for (name, tag, program_id, issuer) in [
        ("nvdax", 211u8, t22(), issuer_with_authority(nvdax(), admin)),
        ("nvdar", 212, t22(), issuer_with_authority(nvdar(), admin)),
        ("nvdaon", 213, t22(), issuer_with_authority(nvdaon(), admin)),
        ("classic9", 214, token::ID, classic(9)),
        ("classic4", 215, token::ID, classic(4)),
        (
            "paused",
            216,
            t22(),
            issuer_with_authority(nvdar(), admin).paused(true),
        ),
        (
            "frozen",
            217,
            t22(),
            issuer_with_authority(nvdaon(), admin).default_state(AccountState::Frozen),
        ),
        (
            "hooked",
            218,
            t22(),
            issuer_with_authority(nvdax(), admin).hook(Some(Pubkey::new_unique())),
        ),
        ("t22plain8", 219, t22(), classic(8)),
    ] {
        let key = Pubkey::new_from_array([tag; 32]);
        let account = if program_id == t22() {
            bytes(issuer.build(), t22())
        } else {
            packed(
                RawMint {
                    mint_authority: COption::Some(admin),
                    supply: 0,
                    decimals: issuer.decimals,
                    is_initialized: true,
                    freeze_authority: COption::None,
                },
                token::ID,
            )
        };
        program.add_account(key, account);
        mints.insert(name, (key, program_id, issuer));
    }
    let mut context = program.start_with_context().await;
    set_clock(&mut context, NOW).await;
    let (config, _) = pda(&[b"config", admin.as_ref()]);
    let a = signer(ADMIN);
    let ix = Instruction {
        program_id: ID,
        accounts: accounts::Initialize {
            admin,
            config,
            quote_mint: quote,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::Initialize {
            roles: Roles {
                market_admin: admin,
                guardian: user(GUARDIAN),
                resolution_admin: admin,
            },
        }
        .data(),
    };
    assert_eq!(send(&mut context, &[ix], &[&a]).await, Ok(()));
    let configure = Instruction {
        program_id: ID,
        accounts: accounts::Configure { admin, config }.to_account_metas(None),
        data: instruction::Configure {
            roles: Roles {
                market_admin: admin,
                guardian: user(GUARDIAN),
                resolution_admin: admin,
            },
            maker_bps: MAKER_BPS,
            taker_bps: TAKER_BPS,
        }
        .data(),
    };
    assert_eq!(send(&mut context, &[configure], &[&a]).await, Ok(()));
    let ix = initialize_pool_ix(admin, config, quote, token::ID, 0);
    assert_eq!(send(&mut context, &[ix], &[&a]).await, Ok(()));
    let id = [5u8; 32];
    let (market, _) = pda(&[b"market", config.as_ref(), &id]);
    let (quote_pool, _) = pool_key(&config, &quote);
    let uri = "ipfs://multi-issuer-e2e".to_string();
    let ix = Instruction {
        program_id: ID,
        accounts: accounts::CreateMarket {
            admin,
            config,
            quote_mint: quote,
            quote_pool,
            quote_vault: pool_vault_key(&quote_pool).0,
            market,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::CreateMarket {
            id,
            terms: Terms {
                condition: [1; 32],
                yes_index: 1,
                no_index: 2,
                rules_hash: [2; 32],
                metadata_hash: solana_sha256_hasher::hashv(&[uri.as_bytes()]).to_bytes(),
                metadata_uri: uri,
                trading_open: 0,
                trading_cutoff: CUTOFF,
                share_decimals: 6,
                tick: TICK,
                step: 1_000,
                min_notional: 1_000,
                max_quantity: 1_000_000_000,
                max_order: 1_000_000_000_000,
                max_wallet: 10_000_000_000_000,
                max_market: 100_000_000_000_000,
            },
        }
        .data(),
    };
    assert_eq!(send(&mut context, &[ix], &[&a]).await, Ok(()));
    (
        Chain {
            context,
            config,
            market,
            quote,
        },
        mints,
    )
}

#[tokio::test]
#[ignore = "Requires a current compiled artifact; set BPF_OUT_DIR=target/deploy and run with --ignored"]
async fn e_listing_admission_and_opening_end_to_end() {
    let (mut chain, mints) = chain().await;
    let (config, market) = (chain.config, chain.market);
    let admin = user(ADMIN);
    let a = signer(ADMIN);
    let ctx = &mut chain.context;
    let pool_ix = |name: &str, payer: Pubkey, admitted: u16| {
        let (mint, program, _) = &mints[name];
        initialize_pool_ix(payer, config, *mint, *program, admitted)
    };
    // initialize_pool: market admin only, exact admission mask.
    assert_eq!(
        send(
            ctx,
            &[pool_ix("nvdax", user(OUTSIDER), 63)],
            &[&signer(OUTSIDER)]
        )
        .await,
        Err(code(ProtocolError::Unauthorized))
    );
    for wrong in [0u16, 62, 31, 127, 64 | 63] {
        assert_eq!(
            send(ctx, &[pool_ix("nvdax", admin, wrong)], &[&a]).await,
            Err(code(ProtocolError::UnsupportedTokenExtension)),
            "admitted {wrong}"
        );
    }
    assert_eq!(
        send(ctx, &[pool_ix("nvdar", admin, 63)], &[&a]).await,
        Err(code(ProtocolError::UnsupportedTokenExtension))
    );
    assert_eq!(
        send(ctx, &[pool_ix("nvdaon", admin, 63)], &[&a]).await,
        Err(code(ProtocolError::UnsupportedTokenExtension))
    );
    assert_eq!(
        send(ctx, &[pool_ix("classic9", admin, 8)], &[&a]).await,
        Err(code(ProtocolError::UnsupportedTokenExtension))
    );
    assert_eq!(
        send(ctx, &[pool_ix("hooked", admin, 63)], &[&a]).await,
        Err(code(ProtocolError::TransferHookEnabled))
    );
    for (name, admitted) in [
        ("nvdax", 63u16),
        ("nvdar", 47),
        ("nvdaon", 62),
        ("classic9", 0),
        ("classic4", 0),
        ("paused", 47),
        ("frozen", 62),
        ("t22plain8", 0),
    ] {
        assert_eq!(
            send(ctx, &[pool_ix(name, admin, admitted)], &[&a]).await,
            Ok(()),
            "{name}"
        );
        let (mint, program, issuer) = &mints[name];
        let (pool, bump) = pool_key(&config, mint);
        let (vault, vault_bump) = pool_vault_key(&pool);
        let state: AssetPool = fetch(ctx, pool).await;
        assert_eq!(
            (
                state.mint,
                state.token_program,
                state.decimals,
                state.admitted,
                state.bump,
                state.vault_bump,
                state.liability
            ),
            (
                *mint,
                *program,
                issuer.decimals,
                admitted,
                bump,
                vault_bump,
                0
            ),
            "{name}"
        );
        // The real token program created the vault with the account extensions
        // its mint requires, frozen only under a frozen default state.
        let vault_account = raw_account(ctx, vault).await;
        assert_eq!(vault_account.owner, *program);
        let parsed = StateWithExtensions::<T22Account>::unpack(&vault_account.data).unwrap();
        assert_eq!(parsed.base.owner, pool);
        assert_eq!(
            parsed.base.state == AccountState::Frozen,
            name == "frozen",
            "{name}"
        );
        if *program == t22() && name != "t22plain8" {
            let kinds = parsed.get_extension_types().unwrap();
            assert!(
                kinds.contains(&ExtensionType::PausableAccount),
                "{name}: {kinds:?}"
            );
        }
    }
    let add = |name: &str, signer_key: Pubkey| {
        let (mint, program, _) = &mints[name];
        add_base_ix(signer_key, config, market, *mint, *program)
    };
    let lifecycle_open = lifecycle_ix(admin, config, market, 0);
    // No base leg yet: cannot open.
    assert_eq!(
        send(ctx, std::slice::from_ref(&lifecycle_open), &[&a]).await,
        Err(code(ProtocolError::InvalidState))
    );
    assert_eq!(
        send(ctx, &[add("nvdax", user(OUTSIDER))], &[&signer(OUTSIDER)]).await,
        Err(code(ProtocolError::Unauthorized))
    );
    assert_eq!(
        send(ctx, &[add("classic4", admin)], &[&a]).await,
        Err(code(ProtocolError::InvalidTerms)),
        "decimals < share decimals"
    );
    assert_eq!(
        send(ctx, &[add("paused", admin)], &[&a]).await,
        Err(code(ProtocolError::IssuerPaused))
    );
    assert_eq!(
        send(ctx, &[add("frozen", admin)], &[&a]).await,
        Err(code(ProtocolError::LegHalted))
    );
    // The quote pool cannot be listed as a base leg.
    let (quote_pool, _) = pool_key(&config, &chain.quote);
    let quote_as_leg = add_base_ix(admin, config, market, chain.quote, token::ID);
    assert_eq!(quote_as_leg.accounts[4].pubkey, quote_pool);
    assert_eq!(
        send(ctx, &[quote_as_leg], &[&a]).await,
        Err(code(ProtocolError::InvalidAsset))
    );
    // List NVDAx: scale 10^(8-6), listing multiplier = effective multiplier now.
    assert_eq!(send(ctx, &[add("nvdax", admin)], &[&a]).await, Ok(()));
    assert_eq!(
        send(ctx, &[add("nvdax", admin)], &[&a]).await,
        Err(code(ProtocolError::InvalidAsset)),
        "duplicate mint"
    );
    // A mint that later shows an unadmitted extension cannot be listed.
    let (nvdar_mint, _, nvdar_issuer) = &mints["nvdar"];
    let original = raw_account(ctx, *nvdar_mint).await;
    let widened = nvdar_issuer.clone().with(Ext::TransferHook {
        authority: None,
        program_id: None,
    });
    ctx.set_account(
        nvdar_mint,
        &AccountSharedData::from(bytes(widened.build(), t22())),
    );
    assert_eq!(
        send(ctx, &[add("nvdar", admin)], &[&a]).await,
        Err(code(ProtocolError::UnsupportedTokenExtension))
    );
    ctx.set_account(nvdar_mint, &AccountSharedData::from(original));
    assert_eq!(send(ctx, &[add("nvdar", admin)], &[&a]).await, Ok(()));
    assert_eq!(send(ctx, &[add("nvdaon", admin)], &[&a]).await, Ok(()));
    assert_eq!(
        send(ctx, &[add("classic9", admin)], &[&a]).await,
        Err(code(ProtocolError::InvalidAsset)),
        "fourth leg"
    );
    let state: Market = fetch(ctx, market).await;
    assert_eq!(state.bases, 3);
    let expected = [
        ("nvdax", 8u8, 100u64, NVDAX_NEW.to_bits()),
        ("nvdar", 9, 1_000, 1f64.to_bits()),
        ("nvdaon", 9, 1_000, NVDAON_M.to_bits()),
    ];
    for (i, (name, decimals, scale, multiplier)) in expected.into_iter().enumerate() {
        let c = i + 1;
        let (mint, _, _) = &mints[name];
        assert_eq!(state.mints[3 * c], *mint);
        assert_eq!(state.decimals[c], decimals);
        assert_eq!(state.pool_bumps[c], pool_key(&config, mint).1);
        let leg = state.legs[i];
        assert_eq!(
            (leg.scale, leg.multiplier, leg.active),
            (scale, multiplier, true),
            "{name}"
        );
    }
    assert_eq!(state.vaults_initialized, 0b001_001_001_001);
    // Claims per collateral; the market opens only when every listed leg is ready.
    for c in 0..3u8 {
        assert_eq!(
            send(ctx, &[initialize_claims_ix(admin, market, c)], &[&a]).await,
            Ok(()),
            "claims {c}"
        );
        assert_eq!(
            send(ctx, std::slice::from_ref(&lifecycle_open), &[&a]).await,
            Err(code(ProtocolError::InvalidState)),
            "after {c}"
        );
    }
    assert!(
        send(ctx, &[initialize_claims_ix(admin, market, 1)], &[&a])
            .await
            .is_err(),
        "claims twice"
    );
    assert!(
        send(ctx, &[initialize_claims_ix(admin, market, 4)], &[&a])
            .await
            .is_err(),
        "unlisted collateral"
    );
    assert_eq!(
        send(ctx, &[initialize_claims_ix(admin, market, 3)], &[&a]).await,
        Ok(())
    );
    let state: Market = fetch(ctx, market).await;
    assert_eq!(state.vaults_initialized, 0xFFF);
    for c in 0..4 {
        for branch in 0..2 {
            let asset = claim_asset(c, branch);
            assert_eq!(state.mints[asset], claim_mint(&market, asset));
            let data = raw_account(ctx, state.mints[asset]).await.data;
            let mint = RawMint::unpack(&data).unwrap();
            assert_eq!(mint.decimals, state.decimals[c], "claim decimals {asset}");
            assert_eq!(mint.mint_authority, COption::Some(market));
        }
    }
    assert_eq!(
        send(
            ctx,
            &[lifecycle_ix(user(OUTSIDER), config, market, 0)],
            &[&signer(OUTSIDER)]
        )
        .await,
        Err(code(ProtocolError::Unauthorized))
    );
    assert_eq!(
        send(ctx, std::slice::from_ref(&lifecycle_open), &[&a]).await,
        Ok(())
    );
    let state: Market = fetch(ctx, market).await;
    assert_eq!(state.state, protocol_core::OPEN);
    // add_base is refused once three legs are listed even while OPEN.
    assert_eq!(
        send(ctx, &[add("t22plain8", admin)], &[&a]).await,
        Err(code(ProtocolError::InvalidAsset))
    );
}

#[tokio::test]
#[ignore = "Requires a current compiled artifact; set BPF_OUT_DIR=target/deploy and run with --ignored"]
async fn e_real_token_2022_deposit_trade_and_split_end_to_end() {
    let (mut chain, mints) = chain().await;
    let (config, market_key) = (chain.config, chain.market);
    let admin = user(ADMIN);
    let a = signer(ADMIN);
    let quote = chain.quote;
    let ctx = &mut chain.context;
    let (x_mint, x_program, _) = mints["nvdax"].clone();
    let (r_mint, r_program, _) = mints["nvdar"].clone();
    for (mint, program, admitted) in [(x_mint, x_program, 63u16), (r_mint, r_program, 47)] {
        assert_eq!(
            send(
                ctx,
                &[initialize_pool_ix(admin, config, mint, program, admitted)],
                &[&a]
            )
            .await,
            Ok(())
        );
        assert_eq!(
            send(
                ctx,
                &[add_base_ix(admin, config, market_key, mint, program)],
                &[&a]
            )
            .await,
            Ok(())
        );
    }
    for c in 0..3 {
        assert_eq!(
            send(ctx, &[initialize_claims_ix(admin, market_key, c)], &[&a]).await,
            Ok(())
        );
    }
    // Opening requires an active leg: delist both, fail, relist one.
    let set_base = |c: u8, active: bool| Instruction {
        program_id: ID,
        accounts: accounts::SetBase {
            actor: admin,
            config,
            market: market_key,
        }
        .to_account_metas(None),
        data: instruction::SetBase {
            collateral: c,
            active,
        }
        .data(),
    };
    assert_eq!(
        send(ctx, &[set_base(1, false), set_base(2, false)], &[&a]).await,
        Ok(())
    );
    assert_eq!(
        send(ctx, &[lifecycle_ix(admin, config, market_key, 0)], &[&a]).await,
        Err(code(ProtocolError::InvalidState))
    );
    assert_eq!(
        send(ctx, &[set_base(1, true), set_base(2, true)], &[&a]).await,
        Ok(())
    );
    assert_eq!(
        send(ctx, &[lifecycle_ix(admin, config, market_key, 0)], &[&a]).await,
        Ok(())
    );
    // Seller S1: 5 NVDAx (8 decimals) deposited into the protocol pool.
    let seller = signer(S1);
    let buyer = signer(B1);
    let x_source = funded_token_account(ctx, x_program, x_mint, &seller, 500_000_000).await;
    let q_source = funded_token_account(ctx, token::ID, quote, &buyer, 10_000_000_000).await;
    for (owner, tag) in [(user(S1), S1), (user(B1), B1)] {
        let ix = Instruction {
            program_id: ID,
            accounts: accounts::InitializeWallet {
                payer: owner,
                owner,
                market: market_key,
                wallet: wallet_key(&market_key, &owner).0,
                trader: trader_key(&config, &owner).0,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::InitializeWallet {}.data(),
        };
        assert_eq!(send(ctx, &[ix], &[&signer(tag)]).await, Ok(()));
    }
    let deposit = |owner: Pubkey, mint: Pubkey, program: Pubkey, external: Pubkey, amount: u64| {
        let (pool, _) = pool_key(&config, &mint);
        Instruction {
            program_id: ID,
            accounts: accounts::PoolTransfer {
                owner,
                pool,
                credit: credit_key(&pool, &owner).0,
                mint,
                vault: pool_vault_key(&pool).0,
                external,
                token_program: program,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::DepositPool {
                amount,
                minimum_credit: amount,
            }
            .data(),
        }
    };
    assert_eq!(
        send(
            ctx,
            &[deposit(user(S1), x_mint, x_program, x_source, 500_000_000)],
            &[&seller]
        )
        .await,
        Ok(())
    );
    assert_eq!(
        send(
            ctx,
            &[deposit(
                user(B1),
                quote,
                token::ID,
                q_source,
                10_000_000_000
            )],
            &[&buyer]
        )
        .await,
        Ok(())
    );
    let (x_pool, _) = pool_key(&config, &x_mint);
    let (q_pool, _) = pool_key(&config, &quote);
    assert_eq!(
        token_amount(ctx, pool_vault_key(&x_pool).0).await,
        500_000_000
    );
    let market: Market = fetch(ctx, market_key).await;
    let m = market.legs[0].multiplier;
    assert_eq!(m, NVDAX_NEW.to_bits());
    // S1 rests an ask of 3 shares of NVDAx funded from its pool credit.
    let ask = OrderTerms {
        recipient: user(S1),
        salt: [41; 32],
        quantity: 3_000_000,
        price: price(180_000),
        expiry: NOW + 5_000,
        nonce: 0,
        max_fee_bps: 1_000,
        branch: 0,
        side: 1,
        funding: 0,
        tif: 0,
        bases: 0b001,
    };
    let reserved = raw(3_000_000, 100, m, true);
    let ix = Instruction {
        program_id: ID,
        accounts: place_metas(
            &config,
            &market_key,
            &market,
            &PlaceAccounts {
                owner: user(S1),
                salt: ask.salt,
                touched: 0b001,
                makers: vec![],
                participants: vec![user(S1)],
                frames: vec![credit_key(&x_pool, &user(S1)).0],
                quote_writable: false,
                leg_writable: [false; 4],
            },
        ),
        data: instruction::Place {
            terms: ask.clone(),
            plan: Plan {
                deadline: NOW + 500,
                next_sequence: 0,
                min_fill: 0,
                maker_bps: MAKER_BPS,
                taker_bps: TAKER_BPS,
                legs: vec![],
            },
            participants: 1,
            delegations: 0,
            touched: 0b001,
        }
        .data(),
    };
    assert_eq!(send(ctx, &[ix], &[&seller]).await, Ok(()));
    let credit: AssetCredit = fetch(ctx, credit_key(&x_pool, &user(S1)).0).await;
    assert_eq!(credit.available, 500_000_000 - reserved);
    // B1 buys all 3 shares with a bid accepting both legs (quote pool funded).
    let bid = OrderTerms {
        recipient: user(B1),
        salt: [42; 32],
        quantity: 3_000_000,
        price: price(181_000),
        expiry: NOW + 5_000,
        nonce: 0,
        max_fee_bps: 1_000,
        branch: 0,
        side: 0,
        funding: 0,
        tif: 0,
        bases: 0b011,
    };
    let (ask_key, _) = order_key(&market_key, &user(S1), &ask.salt);
    let mut participants = vec![user(S1), user(B1)];
    participants.sort();
    let ix = Instruction {
        program_id: ID,
        accounts: place_metas(
            &config,
            &market_key,
            &market,
            &PlaceAccounts {
                owner: user(B1),
                salt: bid.salt,
                touched: 0b001,
                makers: vec![ask_key],
                participants,
                frames: vec![
                    credit_key(&q_pool, &user(B1)).0,
                    credit_key(&x_pool, &user(S1)).0,
                ],
                quote_writable: true,
                leg_writable: [false, true, false, false],
            },
        ),
        data: instruction::Place {
            terms: bid.clone(),
            plan: Plan {
                deadline: NOW + 500,
                next_sequence: 1,
                min_fill: 0,
                maker_bps: MAKER_BPS,
                taker_bps: TAKER_BPS,
                legs: vec![Leg {
                    quantity: 3_000_000,
                }],
            },
            participants: 2,
            delegations: 0,
            touched: 0b001,
        }
        .data(),
    };
    assert_eq!(send(ctx, &[ix], &[&buyer]).await, Ok(()));
    let delivered = raw(3_000_000, 100, m, false);
    let quote_amount = notional_down(3_000_000, price(180_000));
    let buyer_fee = delivered * u64::from(TAKER_BPS) / 10_000;
    let seller_fee = quote_amount * u64::from(MAKER_BPS) / 10_000;
    let b: Wallet = fetch(ctx, wallet_key(&market_key, &user(B1)).0).await;
    let s: Wallet = fetch(ctx, wallet_key(&market_key, &user(S1)).0).await;
    assert_eq!(b.balances[claim_asset(1, 0)], delivered - buyer_fee);
    assert_eq!(b.balances[claim_asset(0, 1)], quote_amount);
    assert_eq!(s.balances[claim_asset(0, 0)], quote_amount - seller_fee);
    assert_eq!(s.balances[claim_asset(1, 1)], delivered);
    let credit: AssetCredit = fetch(ctx, credit_key(&x_pool, &user(S1)).0).await;
    assert_eq!(
        credit.available,
        500_000_000 - delivered,
        "surplus refunded to pool credit"
    );
    let credit: AssetCredit = fetch(ctx, credit_key(&q_pool, &user(B1)).0).await;
    assert_eq!(
        credit.available,
        10_000_000_000 - quote_amount,
        "bid improvement refunded"
    );
    let market: Market = fetch(ctx, market_key).await;
    assert_eq!(market.backing[1], delivered);
    assert_eq!(market.backing[0], quote_amount);
    assert_eq!(market.fees[claim_asset(1, 0)], buyer_fee);
    assert_eq!(market.fees[claim_asset(0, 0)], seller_fee);
    assert_eq!(market.escrow, vec![0; ASSETS]);
    assert_eq!(market.open_notional, 0);
    for branch in 0..2 {
        assert_eq!(
            mint_supply(ctx, market.mints[claim_asset(1, branch)]).await,
            delivered
        );
        assert_eq!(
            mint_supply(ctx, market.mints[claim_asset(0, branch)]).await,
            quote_amount
        );
    }
    // The seller splits remaining NVDAx credit (raw units) and merges it back.
    let split = positions_ix(
        &config,
        &market_key,
        &market,
        user(S1),
        1,
        instruction::Split {
            collateral: 1,
            amount: 12_345,
        }
        .data(),
    );
    let merge = positions_ix(
        &config,
        &market_key,
        &market,
        user(S1),
        1,
        instruction::Merge {
            collateral: 1,
            amount: 12_345,
        }
        .data(),
    );
    assert_eq!(send(ctx, &[split], &[&seller]).await, Ok(()));
    let market_after: Market = fetch(ctx, market_key).await;
    assert_eq!(market_after.backing[1], delivered + 12_345);
    assert_eq!(send(ctx, &[merge], &[&seller]).await, Ok(()));
    let credit: AssetCredit = fetch(ctx, credit_key(&x_pool, &user(S1)).0).await;
    assert_eq!(credit.available, 500_000_000 - delivered);
    // Pausing the issuer blocks custody transfers (withdraw) with IssuerPaused.
    let (issuer_mint, _, issuer) = &mints["nvdax"];
    let paused = issuer.clone().paused(true);
    ctx.set_account(
        issuer_mint,
        &AccountSharedData::from(bytes(paused.build(), t22())),
    );
    let withdraw = {
        let mut ix = deposit(user(S1), x_mint, x_program, x_source, 1_000);
        ix.data = instruction::WithdrawPool {
            amount: 1_000,
            minimum_received: 1_000,
        }
        .data();
        ix
    };
    assert_eq!(
        send(ctx, &[withdraw], &[&seller]).await,
        Err(code(ProtocolError::IssuerPaused))
    );
}

// ---------------- (g) plans made against an older book ----------------

#[tokio::test]
#[ignore = "Requires a current compiled artifact; set BPF_OUT_DIR=target/deploy and run with --ignored"]
async fn g_makers_changed_since_planning_are_skipped_or_capped() {
    let mut w = World::new();
    let asks = three_asks(&mut w, 0);
    let fourth = w.add_order(w.terms(B1, 104, 1, 0, 1, 0b010, 1_000_000, 180_600, 0));
    let planned = [
        (asks[0], 2_000_000),
        (asks[1], 3_000_000),
        (asks[2], 1_500_000),
        (fourth, 1_000_000),
    ];
    let plan_seq = w.market.sequence[0];
    let terms = w.terms(T, 150, 0, 0, 0, 0b111, 8_000_000, 181_000, 0);
    // Since planning: S1's ask was half filled, S2's cancelled, S3's expired,
    // B1's no longer admits the current maker fee, and an unrelated order
    // landed on the branch (the book sequence moved on).
    let mut chain = w.clone();
    let half = {
        let multiplier = chain.market.legs[0].multiplier;
        let scale = chain.scale(1);
        let o = &mut chain.orders[asks[0]].1;
        o.remaining = 1_000_000;
        o.filled = 1_000_000;
        o.reserved = raw(1_000_000, scale, multiplier, true);
        o.open_notional = notional_up(1_000_000, o.terms.price);
        o.remaining
    };
    chain.orders[asks[1]].1.status = 3;
    chain.orders[asks[2]].1.terms.expiry = NOW - 1;
    chain.orders[fourth].1.terms.max_fee_bps = MAKER_BPS - 1;
    chain.add_order(chain.terms(B2, 105, 0, 0, 1, 0b111, 1_000_000, 100_000, 0));
    let outcome = chain.engine(user(T), &terms, &[(asks[0], half)]);
    assert!(
        outcome.fills[0].5 > 0,
        "the capped ask completes with a surplus"
    );
    let mut context = chain.start().await;
    let s = signer(T);
    // Requiring more fill than remains is a stale plan.
    let ix = chain.planned_ix(
        user(T),
        &terms,
        &planned,
        0b111,
        Some(&outcome),
        plan_seq,
        half + 1_000,
    );
    assert_eq!(
        send(&mut context, &[ix], &[&s]).await,
        Err(code(ProtocolError::StalePlan))
    );
    // A plan from a book the chain has not reached yet is stale too.
    let ix = chain.planned_ix(
        user(T),
        &terms,
        &planned,
        0b111,
        Some(&outcome),
        plan_seq + 2,
        0,
    );
    assert_eq!(
        send(&mut context, &[ix], &[&s]).await,
        Err(code(ProtocolError::StalePlan))
    );
    let ix = chain.planned_ix(
        user(T),
        &terms,
        &planned,
        0b111,
        Some(&outcome),
        plan_seq,
        half,
    );
    assert_eq!(send(&mut context, &[ix], &[&s]).await, Ok(()));
    verify_outcome(&mut context, &outcome, "skipped and capped makers").await;
    assert_eq!(outcome.taker.1.filled, half);
    assert_eq!(outcome.taker.1.remaining, 8_000_000 - half);

    // A closed (retired) maker account and a nonce-invalidated maker are skipped.
    let mut w = World::new();
    let asks = three_asks(&mut w, 0);
    let plan_seq = w.market.sequence[0];
    let terms = w.terms(T, 151, 0, 0, 0, 0b111, 6_500_000, 181_000, 1);
    let outcome = w.engine(user(T), &terms, &[(asks[2], 1_500_000)]);
    let mut context = w.start().await;
    context.set_account(&w.orders[asks[0]].0, &AccountSharedData::from(system(0)));
    let (trader, bump) = trader_key(&w.config, &user(S2));
    context.set_account(
        &trader,
        &AccountSharedData::from(state_account(&Trader {
            config: w.config,
            owner: user(S2),
            minimum_nonce: 1,
            delegation_epoch: 0,
            bump,
        })),
    );
    let planned = [
        (asks[0], 2_000_000),
        (asks[1], 3_000_000),
        (asks[2], 1_500_000),
    ];
    let ix = w.planned_ix(
        user(T),
        &terms,
        &planned,
        0b111,
        Some(&outcome),
        plan_seq,
        1_000,
    );
    assert_eq!(send(&mut context, &[ix], &[&s]).await, Ok(()));
    let mut expected = outcome;
    expected.world.orders.remove(asks[0]);
    verify_outcome(
        &mut context,
        &expected,
        "closed and nonce-invalidated makers",
    )
    .await;
    assert_eq!(
        expected.taker.1.status, 3,
        "the IOC releases the unfilled rest"
    );
}

#[tokio::test]
#[ignore = "Requires a current compiled artifact; set BPF_OUT_DIR=target/deploy and run with --ignored"]
async fn g_makers_needing_an_absent_credit_frame_are_skipped() {
    // A completing underlying-funded ask returns its reservation surplus to
    // its pool credit: without that frame it is skipped, not the placement failed.
    let mut w = World::new();
    let asks = three_asks(&mut w, 0);
    let seq = w.market.sequence[0];
    let terms = w.terms(T, 150, 0, 0, 0, 0b001, 2_000_000, 181_000, 0);
    let nothing = w.engine(user(T), &terms, &[]);
    let mut context = w.start().await;
    let ix = w.planned_ix(
        user(T),
        &terms,
        &[(asks[0], 2_000_000)],
        0b001,
        Some(&nothing),
        seq,
        0,
    );
    assert_eq!(send(&mut context, &[ix], &[&signer(T)]).await, Ok(()));
    verify_outcome(&mut context, &nothing, "ask without its frame").await;

    // A pool-funded maker bid whose fill leaves a rounding improvement needs
    // its quote frame likewise.
    let mut w = World::new();
    w.market.terms.step = 1;
    w.market.terms.min_notional = 1;
    // 1 of 3 units at 1.5: reservation 5 -> 3 releases 2, the fill pays 1.
    let bid = w.add_order(w.terms(B1, 111, 0, 0, 0, 0b001, 3, 1_500, 0));
    let seq = w.market.sequence[0];
    let terms = w.terms(T, 150, 1, 0, 1, 0b001, 1, 1_500, 0);
    let filled = w.engine(user(T), &terms, &[(bid, 1)]);
    assert!(
        filled.frames.contains(&(user(B1), 0)),
        "the fill improves the bid"
    );
    let rests = w.engine(user(T), &terms, &[]);
    let mut context = w.start().await;
    let without = w.planned_ix(user(T), &terms, &[(bid, 1)], 0b001, Some(&rests), seq, 0);
    assert_eq!(send(&mut context, &[without], &[&signer(T)]).await, Ok(()));
    verify_outcome(&mut context, &rests, "bid without its frame").await;
    let mut context = w.start().await;
    let with = w.planned_ix(user(T), &terms, &[(bid, 1)], 0b001, Some(&filled), seq, 1);
    assert_eq!(send(&mut context, &[with], &[&signer(T)]).await, Ok(()));
    verify_outcome(&mut context, &filled, "bid with its frame").await;
}

#[tokio::test]
#[ignore = "Requires a current compiled artifact; set BPF_OUT_DIR=target/deploy and run with --ignored"]
async fn g_resting_orders_never_race_past_unseen_crossing_orders() {
    let mut w = World::new();
    let planned_at = w.market.sequence[0];
    // After a quoter planned, S1 rested an ask at 180.000.
    w.add_order(w.terms(S1, 101, 1, 0, 0, 0b001, 1_000_000, 180_000, 0));
    let s = signer(T);
    // A bid at or above it would rest crossed: the quoter must replan (and
    // then match it).
    let crossing = w.terms(T, 150, 0, 0, 1, 0b001, 1_000_000, 180_000, 0);
    let mut context = w.start().await;
    let ix = w.planned_ix(user(T), &crossing, &[], 0, None, planned_at, 0);
    assert_eq!(
        send(&mut context, &[ix], &[&s]).await,
        Err(code(ProtocolError::StalePlan))
    );
    // An order that does not rest cannot cross: immediate-or-cancel passes.
    let ioc = w.terms(T, 151, 0, 0, 1, 0b001, 1_000_000, 180_000, 1);
    let outcome = w.engine(user(T), &ioc, &[]);
    let ix = w.planned_ix(user(T), &ioc, &[], 0, Some(&outcome), planned_at, 0);
    assert_eq!(send(&mut context, &[ix], &[&s]).await, Ok(()));
    verify_outcome(&mut context, &outcome, "ioc").await;
    let w = outcome.world;
    // A quote below the unseen ask, same-side newer orders and orders that
    // did not rest (the IOC above) never conflict: concurrent quoting works.
    let quote = w.terms(T, 152, 0, 0, 1, 0b001, 1_000_000, 179_999, 0);
    let outcome = w.engine(user(T), &quote, &[]);
    let ix = w.planned_ix(user(T), &quote, &[], 0, Some(&outcome), planned_at, 0);
    assert_eq!(send(&mut context, &[ix], &[&s]).await, Ok(()));
    verify_outcome(&mut context, &outcome, "non-crossing quote").await;
    // An ask at or below the newer bid is rejected on the other side too.
    let w = outcome.world;
    let ask = w.terms(S2, 153, 1, 0, 1, 0b010, 1_000_000, 179_999, 0);
    let ix = w.planned_ix(user(S2), &ask, &[], 0b010, None, planned_at, 0);
    assert_eq!(
        send(&mut context, &[ix], &[&signer(S2)]).await,
        Err(code(ProtocolError::StalePlan))
    );
    // Beyond the retained window the chain cannot tell: fail closed.
    let mut w = w;
    for i in 0..=RECENT as u8 {
        w.add_order(w.terms(B2, 160 + i, 0, 1, 1, 0b111, 1_000, 1_000, 0));
    }
    let late = w.terms(T, 154, 0, 1, 1, 0b001, 1_000_000, 100, 0);
    let mut context = w.start().await;
    let old = w.market.sequence[1] - RECENT as u64 - 1;
    assert_eq!(old, 0);
    let ix = w.planned_ix(user(T), &late, &[], 0, None, old, 0);
    assert_eq!(
        send(&mut context, &[ix], &[&s]).await,
        Err(code(ProtocolError::StalePlan))
    );
    let outcome = w.engine(user(T), &late, &[]);
    let ix = w.planned_ix(user(T), &late, &[], 0, Some(&outcome), old + 1, 0);
    assert_eq!(send(&mut context, &[ix], &[&s]).await, Ok(()));
    verify_outcome(&mut context, &outcome, "window edge").await;
}
