//! Independent arithmetic oracles for the MetaDAO comparative review.
//! No upstream implementation is linked or copied. BigUint intentionally avoids
//! the production quote decomposition and its bounded intermediate arithmetic.
use num_bigint::BigUint;
use proptest::prelude::*;
use protocol_core::*;

fn as_amount(value: BigUint) -> Result<u64> {
    match value.to_u64_digits().as_slice() {
        [] => Ok(0),
        [n] => Ok(*n),
        _ => Err(Error::Overflow),
    }
}

fn quote_reference(quantity: u64, price: u128, round_up: bool) -> Result<u64> {
    let product = BigUint::from(quantity) * BigUint::from(price);
    let offset = if round_up { WAD - 1 } else { 0 };
    as_amount((product + BigUint::from(offset)) / BigUint::from(WAD))
}

#[test]
fn full_width_boundary_cross_product() {
    for quantity in [0, 1, 2, u32::MAX as u64, u64::MAX - 1, u64::MAX] {
        for price in [
            0,
            1,
            WAD - 1,
            WAD,
            WAD + 1,
            u64::MAX as u128 * WAD,
            u64::MAX as u128 * WAD + 1,
            u128::MAX,
        ] {
            assert_eq!(
                quote_down(quantity, price),
                quote_reference(quantity, price, false)
            );
            assert_eq!(
                quote_up(quantity, price),
                quote_reference(quantity, price, true)
            );
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(10_000))]

    #[test]
    fn full_u192_products_match_unbounded_oracle(q in any::<u64>(), p in any::<u128>()) {
        prop_assert_eq!(quote_down(q, p), quote_reference(q, p, false));
        prop_assert_eq!(quote_up(q, p), quote_reference(q, p, true));
    }

    #[test]
    fn successful_quotes_and_near_overflow_match_oracle(q in 1u64..=u64::MAX, seed in any::<u128>(), offset in 0u128..4) {
        // Full random prices mostly overflow. Also exercise the complete range
        // of successful amounts and both sides of the exact u64 payout boundary.
        let largest_price = u64::MAX as u128 * WAD / q as u128;
        for p in [seed % (largest_price + 1), largest_price + offset] {
            prop_assert_eq!(quote_down(q, p), quote_reference(q, p, false));
            prop_assert_eq!(quote_up(q, p), quote_reference(q, p, true));
        }
    }

    #[test]
    fn both_maker_sides_preserve_fractional_reservations(
        remaining in 1u64..1_000_000_000_000,
        seed in any::<u64>(),
        ask in WAD / 2..100_000 * WAD,
        spread in 0u128..WAD,
        bid_is_maker in any::<bool>(),
    ) {
        let quantity = seed % remaining + 1;
        let bid = ask + spread;
        let quote = quote_reference(quantity, if bid_is_maker { bid } else { ask }, false).unwrap();
        let actual = fill(quantity, 1, remaining, remaining, bid, ask, bid_is_maker);
        if quote == 0 {
            prop_assert_eq!(actual, Err(Error::InvalidFill));
        } else {
            let actual = actual.unwrap();
            let before = quote_reference(remaining, bid, true).unwrap();
            let after = quote_reference(remaining - quantity, bid, true).unwrap();
            prop_assert_eq!(actual.quote, quote);
            prop_assert_eq!(actual.buyer_reserved, after);
            prop_assert_eq!(before, after + quote + actual.improvement);
            prop_assert_eq!(actual.seller_notional_reduction,
                quote_reference(remaining, ask, true).unwrap()
                    - quote_reference(remaining - quantity, ask, true).unwrap());
        }
    }

    #[test]
    fn aggregate_reference_is_exact_or_fractional_claims_are_not_burned(y in any::<u64>(), n in any::<u64>()) {
        for (yes, no) in [(1, 0), (0, 1), (1, 1)] {
            let denominator = yes + no;
            let aggregate = (y as u128 * yes as u128 + n as u128 * no as u128)
                / denominator as u128;
            let numerator = y as u128 * yes as u128 + n as u128 * no as u128;
            if numerator.is_multiple_of(denominator as u128) {
                prop_assert_eq!(redemption(y, n, yes, no), Ok(aggregate as u64));
            } else {
                prop_assert_eq!(redemption(y, n, yes, no), Err(Error::FractionalRedemption));
            }
            // Merge pairs, redeem exact excess, and KEEP the final odd claim.
            let paired = y.min(n);
            let mut excess_y = y - paired;
            let mut excess_n = n - paired;
            if denominator == 2 {
                excess_y -= excess_y % 2;
                excess_n -= excess_n % 2;
            }
            let recovered = paired as u128
                + redemption(excess_y, excess_n, yes, no).unwrap() as u128;
            prop_assert_eq!(recovered, aggregate);
        }
    }

    #[test]
    fn fragmented_redemption_cannot_overpay_or_reduce_global_backing(
        backing in any::<u64>(), y_seed in any::<u64>(), n_seed in any::<u64>(),
        first_seed in any::<u64>(), second_seed in any::<u64>(),
    ) {
        for (yes, no) in [(1, 0), (0, 1), (1, 1)] {
            let mut y = y_seed.min(backing);
            let mut n = n_seed.min(backing);
            if yes + no == 2 && (y as u128 + n as u128) % 2 == 1 {
                if n > 0 { n -= 1; } else { y -= 1; }
            }
            let mut first_y = first_seed.min(y);
            let mut first_n = second_seed.min(n);
            if yes + no == 2 && (first_y as u128 + first_n as u128) % 2 == 1 {
                if first_n > 0 { first_n -= 1; } else { first_y -= 1; }
            }
            let a = redemption(first_y, first_n, yes, no).unwrap();
            let b = redemption(y - first_y, n - first_n, yes, no).unwrap();
            prop_assert_eq!(a as u128 + b as u128, redemption(y, n, yes, no).unwrap() as u128);
            let remaining_weight = (backing - first_y) as u128 * yes as u128
                + (backing - first_n) as u128 * no as u128;
            let denominator = (yes + no) as u128;
            prop_assert!((backing - a) as u128 >= remaining_weight.div_ceil(denominator));
        }
    }

    #[test]
    fn total_supply_backing_covers_every_permitted_payout(y in any::<u64>(), n in any::<u64>()) {
        prop_assert_eq!(claim_backing(y, n, None), Ok(y.max(n)));
        for (yes, no) in [(1,0), (0,1), (1,1)] {
            let denominator = (yes + no) as u128;
            let weighted = y as u128 * yes as u128 + n as u128 * no as u128;
            let required = claim_backing(y, n, Some((yes, no))).unwrap();
            prop_assert_eq!(required as u128, weighted.div_ceil(denominator));
            prop_assert!(required <= y.max(n));
        }
        prop_assert_eq!(claim_backing(y, n, Some((0,0))), Err(Error::InvalidTerms));
        prop_assert_eq!(claim_backing(y, n, Some((2,1))), Err(Error::InvalidTerms));
    }
}
