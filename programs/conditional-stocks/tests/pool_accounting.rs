use anchor_lang::prelude::*;
use conditional_stocks::{pool::*, state::*, ID};

/// Collateral 0 is the quote, collateral 1 the single listed base leg.
const BASE: usize = 1;

fn market() -> Market {
    let data = vec![0; 8 + Market::INIT_SPACE];
    let mut m = Market::try_deserialize_unchecked(&mut data.as_slice()).unwrap();
    m.ledgers();
    m.config = Pubkey::new_unique();
    m.mints[underlying(QUOTE)] = Pubkey::new_unique();
    m.mints[underlying(BASE)] = Pubkey::new_unique();
    m.bases = 1;
    m.legs[0] = BaseLeg {
        scale: 1,
        multiplier: protocol_core::UNIT_MULTIPLIER,
        active: true,
    };
    for collateral in [QUOTE, BASE] {
        m.pool_bumps[collateral] = Pubkey::find_program_address(
            &[
                b"pool",
                m.config.as_ref(),
                m.mints[underlying(collateral)].as_ref(),
            ],
            &ID,
        )
        .1;
    }
    m
}
fn bytes<T: AccountSerialize>(value: &T) -> Vec<u8> {
    let mut data = Vec::new();
    value.try_serialize(&mut data).unwrap();
    data
}
fn wallet(owner: Pubkey) -> Wallet {
    Wallet {
        market: Pubkey::new_unique(),
        owner,
        balances: [0; ASSETS],
        open_notional: 0,
        bump: 0,
    }
}

#[test]
fn credit_identity_writability_and_owner_are_enforced() {
    let mut m = market();
    let owner = Pubkey::new_unique();
    let pool = pool_address(&m.config, &m.mints[underlying(BASE)]);
    let (key, bump) =
        Pubkey::find_program_address(&[b"asset-credit", pool.as_ref(), owner.as_ref()], &ID);
    let mut data = bytes(&AssetCredit {
        pool,
        owner,
        available: 50,
        bump,
    });
    let mut lamports = 1;
    let mut wallet = wallet(owner);
    let foreign = Pubkey::new_unique();
    for (address, program, writable) in [
        (&foreign, &ID, true),
        (&key, &foreign, true),
        (&key, &ID, false),
    ] {
        let info = AccountInfo::new(
            address,
            false,
            writable,
            &mut lamports,
            &mut data,
            program,
            false,
        );
        assert!(CreditFrame::load(&info, &m).is_err());
    }
    let info = AccountInfo::new(&key, false, true, &mut lamports, &mut data, &ID, false);
    let frame = CreditFrame::load(&info, &m).unwrap();
    assert_eq!(frame.asset, underlying(BASE));
    wallet.owner = foreign;
    assert!(frame.hydrate(&mut m, &mut wallet).is_err());
    wallet.owner = owner;
    frame.hydrate(&mut m, &mut wallet).unwrap();
    assert!(frame.hydrate(&mut m, &mut wallet).is_err());
    assert_eq!(wallet.balances[underlying(BASE)], 50);
    assert_eq!(m.credits[underlying(BASE)], 50);
}

#[test]
fn pool_solvency_checks_cover_all_markets_not_only_local_backing() {
    let mut m = market();
    m.backing[BASE] = 10;
    let mint = m.mints[underlying(BASE)];
    let (key, bump) =
        Pubkey::find_program_address(&[b"pool", m.config.as_ref(), mint.as_ref()], &ID);
    let vault_bump = Pubkey::find_program_address(&[b"pool-vault", key.as_ref()], &ID).1;
    let mut data = bytes(&AssetPool {
        config: m.config,
        mint,
        token_program: anchor_spl::token::ID,
        liability: 100,
        decimals: 6,
        bump,
        admitted: 0,
        vault_bump,
    });
    let mut lamports = 1;
    let info = AccountInfo::new(&key, false, false, &mut lamports, &mut data, &ID, false);
    assert!(validate_pool(&info, &m, BASE, 99).is_err()); // local market needs only 10
    validate_pool(&info, &m, BASE, 100).unwrap();
    validate_pool(&info, &m, BASE, 101).unwrap(); // surplus is not credited
    assert!(validate_pool(&info, &m, QUOTE, 100).is_err());
    assert!(validate_pool(&info, &m, 2, 100).is_err()); // unlisted leg
    m.config = Pubkey::new_unique();
    assert!(validate_pool(&info, &m, BASE, 100).is_err());
}

#[test]
fn raw_unit_conservation_cannot_move_value_between_mints_or_overflow() {
    let mut m = market();
    let owner = Pubkey::new_unique();
    let mut wallet = wallet(owner);
    let (base, quote) = (underlying(BASE), underlying(QUOTE));
    for value in [0, 1, 2, 1_000_000, u64::MAX - 1, u64::MAX] {
        m.credits = vec![0; ASSETS];
        m.escrow = vec![0; ASSETS];
        m.backing = [0; COLLATERALS];
        wallet.balances = [0; ASSETS];
        m.credit(&mut wallet, base, value).unwrap();
        let before = m.liabilities().unwrap();
        m.debit(&mut wallet, base, value).unwrap();
        m.backing[BASE] = value;
        conserved(&m, before).unwrap();
        m.backing[BASE] = 0;
        m.credit(&mut wallet, base, value).unwrap();
        conserved(&m, before).unwrap();
        if value > 0 {
            m.debit(&mut wallet, base, 1).unwrap();
            m.credit(&mut wallet, quote, 1).unwrap();
            assert!(conserved(&m, before).is_err());
        }
    }
    wallet.balances[base] = u64::MAX;
    assert!(m.credit(&mut wallet, base, 1).is_err());
    assert!(m.debit(&mut wallet, quote, 2).is_err());
}

#[test]
fn randomized_reserve_release_flush_roundtrips_preserve_global_credit() {
    let mut seed = 0x1337u64;
    let base = underlying(BASE);
    for _ in 0..10_000 {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let value = seed;
        let reserve = value / 3;
        let mut m = market();
        let owner = Pubkey::new_unique();
        let pool = pool_address(&m.config, &m.mints[base]);
        let (key, bump) =
            Pubkey::find_program_address(&[b"asset-credit", pool.as_ref(), owner.as_ref()], &ID);
        let mut data = bytes(&AssetCredit {
            pool,
            owner,
            available: value,
            bump,
        });
        let mut lamports = 1;
        let info = AccountInfo::new(&key, false, true, &mut lamports, &mut data, &ID, false);
        let mut w = wallet(owner);
        let (frame, before) = hydrate_one(&info, &mut m, &mut w, base).unwrap();
        m.debit(&mut w, base, reserve).unwrap();
        m.escrow[base] += reserve as u128;
        conserved(&m, before).unwrap();
        m.escrow[base] -= reserve as u128;
        m.credit(&mut w, base, reserve).unwrap();
        flush_one(frame, before, &info, &mut m, &mut w).unwrap();
        assert_eq!(
            AssetCredit::try_deserialize(&mut info.try_borrow_data().unwrap().as_ref())
                .unwrap()
                .available,
            value
        );
        assert_eq!(w.balances, [0; ASSETS]);
        assert_eq!(m.credits, vec![0; ASSETS]);
    }
}
