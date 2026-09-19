use anchor_lang::prelude::*;
use conditional_stocks::{pool::*, state::*, ID};

fn market() -> Market {
    let data = vec![0; 8 + Market::INIT_SPACE];
    let mut m = Market::try_deserialize_unchecked(&mut data.as_slice()).unwrap();
    m.config = Pubkey::new_unique();
    m.mints[0] = Pubkey::new_unique();
    m.mints[1] = Pubkey::new_unique();
    m
}
fn bytes<T: AccountSerialize>(value: &T) -> Vec<u8> {
    let mut data = Vec::new();
    value.try_serialize(&mut data).unwrap();
    data
}

#[test]
fn credit_identity_writability_and_owner_are_enforced() {
    let mut m = market();
    let owner = Pubkey::new_unique();
    let pool = pool_address(&m.config, &m.mints[0]);
    let (key, bump) =
        Pubkey::find_program_address(&[b"asset-credit", pool.as_ref(), owner.as_ref()], &ID);
    let mut data = bytes(&AssetCredit {
        pool,
        owner,
        available: 50,
        bump,
    });
    let mut lamports = 1;
    let mut wallet = Wallet {
        market: Pubkey::new_unique(),
        owner,
        balances: [0; 6],
        open_notional: 0,
        bump: 0,
    };
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
    wallet.owner = foreign;
    assert!(frame.hydrate(&mut m, &mut wallet).is_err());
    wallet.owner = owner;
    frame.hydrate(&mut m, &mut wallet).unwrap();
    assert!(frame.hydrate(&mut m, &mut wallet).is_err());
    assert_eq!(wallet.balances[0], 50);
    assert_eq!(m.credits[0], 50);
}

#[test]
fn pool_solvency_checks_cover_all_markets_not_only_local_backing() {
    let mut m = market();
    m.backing[0] = 10;
    let (key, bump) =
        Pubkey::find_program_address(&[b"pool", m.config.as_ref(), m.mints[0].as_ref()], &ID);
    let mut data = bytes(&AssetPool {
        config: m.config,
        mint: m.mints[0],
        token_program: anchor_spl::token::ID,
        liability: 100,
        decimals: 6,
        bump,
    });
    let mut lamports = 1;
    let info = AccountInfo::new(&key, false, false, &mut lamports, &mut data, &ID, false);
    assert!(validate_pool(&info, &m, 0, 99).is_err()); // local market needs only 10
    validate_pool(&info, &m, 0, 100).unwrap();
    validate_pool(&info, &m, 0, 101).unwrap(); // surplus is not credited
    assert!(validate_pool(&info, &m, 1, 100).is_err());
    m.config = Pubkey::new_unique();
    assert!(validate_pool(&info, &m, 0, 100).is_err());
}

#[test]
fn raw_unit_conservation_cannot_move_value_between_mints_or_overflow() {
    let mut m = market();
    let owner = Pubkey::new_unique();
    let mut wallet = Wallet {
        market: Pubkey::new_unique(),
        owner,
        balances: [0; 6],
        open_notional: 0,
        bump: 0,
    };
    for value in [0, 1, 2, 1_000_000, u64::MAX - 1, u64::MAX] {
        m.credits = [0; 6];
        m.escrow = [0; 6];
        m.backing = [0; 2];
        wallet.balances = [0; 6];
        m.credit(&mut wallet, 0, value).unwrap();
        let before = [m.liability(0).unwrap(), m.liability(1).unwrap()];
        m.debit(&mut wallet, 0, value).unwrap();
        m.backing[0] = value;
        conserved(&m, before).unwrap();
        m.backing[0] = 0;
        m.credit(&mut wallet, 0, value).unwrap();
        conserved(&m, before).unwrap();
        if value > 0 {
            m.debit(&mut wallet, 0, 1).unwrap();
            m.credit(&mut wallet, 1, 1).unwrap();
            assert!(conserved(&m, before).is_err());
        }
    }
    wallet.balances[0] = u64::MAX;
    assert!(m.credit(&mut wallet, 0, 1).is_err());
    assert!(m.debit(&mut wallet, 1, 2).is_err());
}

#[test]
fn randomized_reserve_release_flush_roundtrips_preserve_global_credit() {
    let mut seed = 0x1337u64;
    for _ in 0..10_000 {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let value = seed;
        let reserve = value / 3;
        let mut m = market();
        let owner = Pubkey::new_unique();
        let pool = pool_address(&m.config, &m.mints[0]);
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
        let mut w = Wallet {
            market: Pubkey::new_unique(),
            owner,
            balances: [0; 6],
            open_notional: 0,
            bump: 0,
        };
        let (frame, before) = hydrate_one(&info, &mut m, &mut w, 0).unwrap();
        m.debit(&mut w, 0, reserve).unwrap();
        m.escrow[0] += reserve as u128;
        conserved(&m, before).unwrap();
        m.escrow[0] -= reserve as u128;
        m.credit(&mut w, 0, reserve).unwrap();
        flush_one(frame, before, &info, &mut m, &mut w).unwrap();
        assert_eq!(
            AssetCredit::try_deserialize(&mut info.try_borrow_data().unwrap().as_ref())
                .unwrap()
                .available,
            value
        );
        assert_eq!(w.balances, [0; 6]);
        assert_eq!(m.credits, [0; 6]);
    }
}
