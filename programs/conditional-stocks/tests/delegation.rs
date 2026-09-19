use anchor_lang::prelude::*;
use conditional_stocks::{delegation::*, state::*, ID};

fn grant() -> (Pubkey, TradingDelegate) {
    let config = Pubkey::new_unique();
    let owner = Pubkey::new_unique();
    let delegate = Pubkey::new_unique();
    let (address, bump) = Pubkey::find_program_address(
        &[
            b"delegate",
            config.as_ref(),
            owner.as_ref(),
            delegate.as_ref(),
        ],
        &ID,
    );
    (
        address,
        TradingDelegate {
            config,
            owner,
            delegate,
            market: Pubkey::default(),
            epoch: 7,
            expires_at: 100,
            max_order_quote: 20,
            remaining_quote: 40,
            max_fee_bps: 50,
            permissions: TRADE | CANCEL,
            revoked: false,
            bump,
        },
    )
}
fn terms(owner: Pubkey) -> OrderTerms {
    let mut salt = [0; 32];
    salt[..8].copy_from_slice(b"PRBLOv02");
    OrderTerms {
        recipient: owner,
        salt,
        quantity: 10,
        price: 2 * protocol_core::WAD,
        expiry: 100,
        nonce: 0,
        max_fee_bps: 50,
        branch: 0,
        side: 0,
        funding: 0,
        tif: 0,
    }
}

#[test]
fn grant_limits_are_finite_explicit_and_bounded() {
    let good = DelegateLimits {
        expires_at: 101,
        max_order_quote: 1,
        total_quote: u64::MAX,
        max_fee_bps: 1000,
        permissions: TRADE | CANCEL,
    };
    good.validate(100).unwrap();
    for expiry in [i64::MIN, -1, 0, 99, 100, 101 + MAX_GRANT_LIFETIME, i64::MAX] {
        assert!(DelegateLimits {
            expires_at: expiry,
            ..good.clone()
        }
        .validate(100)
        .is_err());
    }
    DelegateLimits {
        expires_at: 100 + MAX_GRANT_LIFETIME,
        ..good.clone()
    }
    .validate(100)
    .unwrap();
    assert!(DelegateLimits {
        expires_at: i64::MAX,
        ..good.clone()
    }
    .validate(i64::MIN)
    .is_err());
    for permissions in 0..=255u8 {
        assert_eq!(
            DelegateLimits {
                permissions,
                ..good.clone()
            }
            .validate(100)
            .is_ok(),
            [TRADE, TRADE | CANCEL].contains(&permissions)
        );
    }
    assert!(DelegateLimits {
        max_order_quote: 0,
        ..good.clone()
    }
    .validate(100)
    .is_err());
    assert!(DelegateLimits {
        total_quote: 0,
        ..good.clone()
    }
    .validate(100)
    .is_err());
    assert!(DelegateLimits {
        max_fee_bps: 1001,
        ..good
    }
    .validate(100)
    .is_err());
}

#[test]
fn identity_binds_owner_config_delegate_and_pda() {
    let (key, g) = grant();
    g.identity(&key, &g.config, &g.owner, &g.delegate).unwrap();
    let wrong = Pubkey::new_unique();
    for args in [
        (&wrong, &g.config, &g.owner, &g.delegate),
        (&key, &wrong, &g.owner, &g.delegate),
        (&key, &g.config, &wrong, &g.delegate),
        (&key, &g.config, &g.owner, &wrong),
    ] {
        assert!(g.identity(args.0, args.1, args.2, args.3).is_err());
    }
}

#[test]
fn revocation_expiry_epoch_scope_and_permissions_are_independent() {
    let (_, mut g) = grant();
    let market = Pubkey::new_unique();
    g.authorize(&market, 7, 99, TRADE).unwrap();
    assert!(!g.active(7, 100));
    assert!(!g.active(7, 101));
    assert!(!g.active(8, 99));
    assert!(!g.active(6, 99));
    g.market = market;
    g.authorize(&market, 7, 99, CANCEL).unwrap();
    assert!(g.authorize(&Pubkey::new_unique(), 7, 99, TRADE).is_err());
    g.permissions = TRADE;
    assert!(g.authorize(&market, 7, 99, CANCEL).is_err());
    g.revoked = true;
    assert!(!g.active(7, 99));
}

#[test]
fn budget_cannot_be_recycled_or_overdrawn_and_does_not_invalidate_resting_orders() {
    let (_, mut g) = grant();
    let t = terms(g.owner);
    g.charge(&t, 20).unwrap();
    assert_eq!(g.remaining_quote, 20);
    g.charge(&t, 20).unwrap();
    assert_eq!(g.remaining_quote, 0);
    assert!(g.active(7, 99)); // Reserved makers can still fill after budget exhaustion.
    assert!(g.charge(&t, 1).is_err());
    assert_eq!(g.remaining_quote, 0);
    g.remaining_quote = u64::MAX;
    g.max_order_quote = u64::MAX;
    assert!(g.charge(&t, 0).is_err());
    g.charge(&t, u64::MAX).unwrap();
    assert_eq!(g.remaining_quote, 0);
}

#[test]
fn recipient_fee_expiry_and_nonce_attacks_never_consume_allowance() {
    let (_, mut g) = grant();
    for attack in 0..5 {
        let mut t = terms(g.owner);
        match attack {
            0 => t.recipient = g.delegate,
            1 => t.max_fee_bps = 51,
            2 => t.expiry = 101,
            3 => t.salt = [0; 32],
            _ => t.nonce = 1,
        }
        assert!(g.charge(&t, 10).is_err());
        assert_eq!(g.remaining_quote, 40);
    }
    assert!(g.charge(&terms(g.owner), 21).is_err());
    assert_eq!(g.remaining_quote, 40);
}

#[test]
fn raw_grants_require_program_ownership_and_the_correct_discriminator() {
    let (key, g) = grant();
    let mut data = Vec::new();
    g.try_serialize(&mut data).unwrap();
    let mut lamports = 1;
    let wrong = Pubkey::new_unique();
    assert!(read_grant(&AccountInfo::new(
        &key,
        false,
        false,
        &mut lamports,
        &mut data,
        &wrong,
        false
    ))
    .is_err());
    read_grant(&AccountInfo::new(
        &key,
        false,
        false,
        &mut lamports,
        &mut data,
        &ID,
        false,
    ))
    .unwrap();
    data[0] ^= 1;
    assert!(read_grant(&AccountInfo::new(
        &key,
        false,
        false,
        &mut lamports,
        &mut data,
        &ID,
        false
    ))
    .is_err());
}
