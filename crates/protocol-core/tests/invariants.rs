use proptest::prelude::*;
use protocol_core::*;

fn caps() -> Caps {
    Caps {
        step: 1,
        tick: WAD,
        min_notional: 1,
        max_quantity: 1_000,
        max_order: 1_000,
        max_wallet: 2_000,
        max_market: 4_000,
    }
}

#[test]
fn raw_unit_vectors_and_numeric_limits() {
    assert_eq!(
        quote_down(1_000_000_000_000_000_000, 200_000_000),
        Ok(200_000_000)
    );
    assert_eq!(quote_down(3, WAD / 2), Ok(1));
    assert_eq!(quote_up(3, WAD / 2), Ok(2));
    assert_eq!(quote_down(0, u128::MAX), Ok(0));
    assert_eq!(quote_up(0, u128::MAX), Ok(0));
    assert_eq!(quote_up(u64::MAX, WAD), Ok(u64::MAX));
    assert_eq!(quote_up(1, 0), Ok(0));
    assert_eq!(quote_down(u64::MAX, u128::MAX), Err(Error::Overflow));
    assert_eq!(quote_down(u64::MAX, 2 * WAD), Err(Error::Overflow));
    assert_eq!(quote_up(u64::MAX, WAD + 1), Err(Error::Overflow));
    assert_eq!(
        quote_up(1, u64::MAX as u128 * WAD + 1),
        Err(Error::Overflow)
    );
}

#[test]
fn fee_bounds_and_carry() {
    assert_eq!(fee(0, 0, 0), Ok((0, 0)));
    assert_eq!(fee(1, 1_000, 9_999), Ok((1, 999)));
    assert_eq!(fee(u64::MAX, 1_000, 9_999), Ok((u64::MAX / 10 + 1, 4_999)));
    assert_eq!(fee(10, 0, 9_999), Ok((0, 9_999)));
    assert_eq!(fee(1, 1_001, 0), Err(Error::InvalidFee));
    assert_eq!(fee(1, 0, 10_000), Err(Error::InvalidFee));
    let mut total = 0;
    let mut carry = 0;
    for _ in 0..10_000 {
        let (charged, next) = fee(1, 7, carry).unwrap();
        total += charged;
        carry = next;
    }
    assert_eq!((total, carry), (7, 0));
}

#[test]
fn market_feasibility_and_order_caps() {
    assert_eq!(caps().validate(), Ok(()));
    let invalid = [
        Caps { step: 0, ..caps() },
        Caps { tick: 0, ..caps() },
        Caps {
            min_notional: 0,
            ..caps()
        },
        Caps {
            max_quantity: 0,
            ..caps()
        },
        Caps {
            max_order: 0,
            ..caps()
        },
        Caps {
            max_wallet: 999,
            ..caps()
        },
        Caps {
            max_market: 1_999,
            ..caps()
        },
        Caps { tick: 1, ..caps() },
    ];
    for terms in invalid {
        assert!(terms.validate().is_err());
    }
    assert!(Caps {
        step: u64::MAX,
        max_quantity: u64::MAX,
        tick: u128::MAX,
        ..caps()
    }
    .validate()
    .is_err());
    assert!(Caps {
        tick: 2 * WAD,
        min_notional: 3,
        max_order: 3,
        ..caps()
    }
    .validate()
    .is_err());
    assert!(Caps {
        min_notional: 1,
        max_order: 1,
        max_wallet: 1,
        max_market: 1,
        ..caps()
    }
    .validate()
    .is_err());
    assert_eq!(caps().validate_order(1, WAD), Ok(1));
    for (quantity, price) in [
        (0, WAD),
        (1, 0),
        (1, WAD + 1),
        (1_001, WAD),
        (1, 1_001 * WAD),
    ] {
        assert!(caps().validate_order(quantity, price).is_err());
    }
    assert!(Caps { step: 2, ..caps() }.validate_order(1, WAD).is_err());
    assert!(Caps {
        min_notional: 2,
        ..caps()
    }
    .validate_order(1, WAD)
    .is_err());
    assert!(Caps { step: 0, ..caps() }.validate_order(1, WAD).is_err());
    assert!(Caps { tick: 0, ..caps() }.validate_order(1, WAD).is_err());
    assert_eq!(caps().final_exposure(2_000, 4_000), Ok(()));
    for (wallet, market) in [(1, 0), (2_001, 3_000), (0, 4_001)] {
        assert!(caps().final_exposure(wallet, market).is_err());
    }
}

#[test]
fn lifecycle_nonce_and_quote_boundaries() {
    assert_eq!(trading(OPEN, false, 10, 10, 20), Ok(()));
    for (state, paused, now) in [
        (FROZEN, false, 10),
        (OPEN, true, 10),
        (OPEN, false, 9),
        (OPEN, false, 20),
    ] {
        assert!(trading(state, paused, now, 10, 20).is_err());
    }
    assert_eq!(valid_expiry(10, 20, 20), Ok(()));
    assert!(valid_expiry(10, 10, 20).is_err());
    assert!(valid_expiry(10, 21, 20).is_err());
    assert_eq!(valid_nonce(1, 1), Ok(()));
    assert_eq!(valid_nonce(0, 1), Err(Error::InvalidNonce));
    assert_eq!(guard(10, 20, 30, (1, 2, 3), (1, 2, 3)), Ok(()));
    assert!(guard(20, 20, 30, (1, 2, 3), (1, 2, 3)).is_err());
    assert!(guard(10, 31, 30, (1, 2, 3), (1, 2, 3)).is_err());
    // Orders placed since planning never invalidate a plan; a plan from a
    // future book or at other fee rates does.
    assert_eq!(guard(10, 20, 30, (1, 2, 3), (2, 2, 3)), Ok(()));
    assert_eq!(guard(10, 20, 30, (1, 2, 3), (u64::MAX, 2, 3)), Ok(()));
    assert!(guard(10, 20, 30, (2, 2, 3), (1, 2, 3)).is_err());
    assert!(guard(10, 20, 30, (1, 2, 3), (1, 3, 3)).is_err());
    assert!(guard(10, 20, 30, (1, 2, 3), (1, 2, 4)).is_err());
    assert!(!releasable(OPEN, 10, 20, 1, 1));
    assert!(releasable(FROZEN, 10, 20, 1, 1));
    assert!(releasable(OPEN, 20, 20, 1, 1));
    assert!(releasable(OPEN, 10, 20, 0, 1));
}

#[test]
fn permitted_payouts_and_exact_invalid_redemption() {
    for yes in 0..=3 {
        for no in 0..=3 {
            assert_eq!(
                payout(yes, no).is_ok(),
                matches!((yes, no), (1, 0) | (0, 1) | (1, 1))
            );
        }
    }
    assert_eq!(redemption(11, 19, 1, 0), Ok(11));
    assert_eq!(redemption(11, 19, 0, 1), Ok(19));
    assert_eq!(redemption(11, 19, 1, 1), Ok(15));
    assert_eq!(redemption(1, 1, 1, 1), Ok(1));
    assert_eq!(redemption(1, 0, 1, 1), Err(Error::FractionalRedemption));
    assert_eq!(redemption(0, 1, 1, 1), Err(Error::FractionalRedemption));
    assert_eq!(redemption(u64::MAX, u64::MAX, 1, 1), Ok(u64::MAX));
    assert!(redemption(1, 1, 0, 0).is_err());
}

#[test]
fn maker_price_reservations_and_rejection() {
    let maker_sell = fill(2, 1, 3, 4, 3 * WAD, 2 * WAD, false).unwrap();
    assert_eq!(
        (
            maker_sell.quote,
            maker_sell.improvement,
            maker_sell.buyer_reserved
        ),
        (4, 2, 3)
    );
    let maker_buy = fill(2, 1, 3, 4, 3 * WAD, 2 * WAD, true).unwrap();
    assert_eq!((maker_buy.quote, maker_buy.improvement), (6, 0));
    for (qty, step, buy, sell, bid, ask) in [
        (0, 1, 1, 1, WAD, WAD),
        (1, 0, 1, 1, WAD, WAD),
        (1, 2, 1, 1, WAD, WAD),
        (2, 1, 1, 2, WAD, WAD),
        (2, 1, 2, 1, WAD, WAD),
        (1, 1, 1, 1, WAD, 0),
        (1, 1, 1, 1, WAD, 2 * WAD),
        (1, 1, 1, 1, 1, 1),
    ] {
        assert!(fill(qty, step, buy, sell, bid, ask, false).is_err());
    }
    assert!(fill(u64::MAX, 1, u64::MAX, u64::MAX, u128::MAX, u128::MAX, true).is_err());
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(10_000))]

    #[test]
    fn rounding_matches_wide_reference(q in any::<u64>(), p in 0u128..=u64::MAX as u128) {
        let product = q as u128 * p;
        let down = product / WAD;
        let up = down + u128::from(!product.is_multiple_of(WAD));
        prop_assert_eq!(quote_down(q,p), u64::try_from(down).map_err(|_| Error::Overflow));
        prop_assert_eq!(quote_up(q,p), u64::try_from(up).map_err(|_| Error::Overflow));
    }

    #[test]
    fn split_fill_reservation_conservation(remaining in 1u64..1_000_000, seed in any::<u64>(),
        price in WAD..10_000*WAD, discount in 0u128..WAD) {
        let qty = seed % remaining + 1;
        let executed = fill(qty,1,remaining,remaining,price,price-discount,false).unwrap();
        prop_assert_eq!(quote_up(remaining,price).unwrap(), executed.buyer_reserved + executed.quote + executed.improvement);
        prop_assert_eq!(executed.buyer_notional_reduction + executed.buyer_reserved,quote_up(remaining,price).unwrap());
    }

    #[test]
    fn fee_fragmentation_cannot_erase_fees(a in 0u64..u64::MAX/2, b in 0u64..u64::MAX/2,
        rate in 0u16..=MAX_FEE_BPS, carry in 0u16..BPS) {
        let (fa,ca) = fee(a,rate,carry).unwrap();
        let (fb,cb) = fee(b,rate,ca).unwrap();
        prop_assert_eq!((fa+fb,cb),fee(a+b,rate,carry).unwrap());
        prop_assert!(fa <= a && fb <= b);
    }

    #[test]
    fn invalid_payout_never_exceeds_backing(yes in any::<u64>(), no in any::<u64>()) {
        let sum = yes as u128 + no as u128;
        if sum.is_multiple_of(2) {
            let value = redemption(yes,no,1,1).unwrap();
            prop_assert!(value <= yes.max(no));
            prop_assert_eq!(value as u128,sum/2);
        } else {
            prop_assert_eq!(redemption(yes,no,1,1),Err(Error::FractionalRedemption));
        }
    }
}

#[test]
fn crossing_is_strictly_between_opposite_sides() {
    assert!(crosses(0, 60, 1, 60));
    assert!(crosses(0, 61, 1, 60));
    assert!(!crosses(0, 59, 1, 60));
    assert!(crosses(1, 60, 0, 60));
    assert!(crosses(1, 59, 0, 60));
    assert!(!crosses(1, 61, 0, 60));
    for (a, b) in [
        (0, 0),
        (1, 1),
        (0, SIDE_NONE),
        (1, SIDE_NONE),
        (SIDE_NONE, 0),
    ] {
        assert!(!crosses(a, 100, b, 1));
        assert!(!crosses(a, 1, b, 100));
    }
}

#[test]
fn resting_orders_never_cross_placements_their_plan_could_not_see() {
    const WINDOW: usize = 4;
    // Placements 0..6 retained modulo 4: 2 = ask@50, 3 = bid@40, 4 = filled, 5 = ask@70.
    let mut ring = [(0u128, SIDE_NONE); WINDOW];
    for (sequence, price, side) in [(2usize, 50, 1), (3, 40, 0), (4, 55, SIDE_NONE), (5, 70, 1)] {
        ring[sequence % WINDOW] = (price, side);
    }
    let entry = |slot: usize| ring[slot];
    // Nothing placed since planning.
    assert_eq!(race_free(WINDOW, 6, 6, 0, 1_000, entry), Ok(()));
    // A bid below every newer ask and a same-side newer bid is fine.
    assert_eq!(race_free(WINDOW, 3, 6, 0, 49, entry), Ok(()));
    // A bid at or above a newer ask it never matched is rejected.
    assert_eq!(
        race_free(WINDOW, 3, 6, 0, 70, entry),
        Err(Error::StaleQuote)
    );
    // Placements that did not rest never conflict.
    assert_eq!(race_free(WINDOW, 4, 6, 0, 69, entry), Ok(()));
    // An ask at or below a newer bid is rejected; above it is fine.
    assert_eq!(
        race_free(WINDOW, 3, 6, 1, 40, entry),
        Err(Error::StaleQuote)
    );
    assert_eq!(race_free(WINDOW, 3, 6, 1, 41, entry), Ok(()));
    // Beyond the retained window fails closed.
    assert_eq!(race_free(WINDOW, 1, 6, 0, 1, entry), Err(Error::StaleQuote));
    assert_eq!(race_free(WINDOW, 7, 6, 0, 1, entry), Err(Error::StaleQuote));
    assert_eq!(race_free(0, 6, 6, 0, 1, entry), Err(Error::StaleQuote));
}
