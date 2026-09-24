//! Exhaustive checks of the ScaledUiAmount conversion rules shared by every
//! multi-issuer market: `multiplier_parts`, `base_raw` and `within_band`.
//!
//! Every expectation is derived from references written here that never call
//! the production helpers: a big-integer decoder of the IEEE-754 fields, an
//! f64 doubling decoder (exact, since doubling a finite binary64 is exact) and
//! big-rational cross multiplication. The golden table is mirrored by the
//! TypeScript client tests; `--nocapture` prints it in a stable CSV format.
use num_bigint::BigUint;
use protocol_core::*;

/// (share units, scale, multiplier f64 bits, raw rounded down, raw rounded up).
/// Computed independently with Python `fractions.Fraction`.
pub const GOLDEN: [(u64, u64, u64, u64, u64); 18] = [
    (1_000_000, 100, 0x3FF0000000000000, 100_000_000, 100_000_000), // 1.0
    (1_000_000, 100, 0x3FF006F7D589FEA9, 99_830_169, 99_830_170),   // 1.001701196801074 (NVDAx new)
    (1_000_000, 100, 0x3FF003C2AC1BF43F, 99_908_276, 99_908_277), // 1.0009180758490996 (NVDAx old)
    (
        1_000_000,
        1000,
        0x3FF007069197BB83,
        998_287_688,
        998_287_689,
    ), // 1.0017152487959897 (NVDAon)
    (
        1_000_000,
        1000,
        0x3FF0000000000000,
        1_000_000_000,
        1_000_000_000,
    ), // 1.0 (NVDAr)
    (1, 100, 0x3FF006F7D589FEA9, 99, 100),                        // 1.001701196801074
    (
        123_456_789,
        1000,
        0x3FF026CD3C9CCD2C,
        122_298_248_787,
        122_298_248_788,
    ), // 1.0094730727840426
    (1, 1, 0x3FF003C2AC1BF43F, 0, 1),                             // 1.0009180758490996
    (1, 1000, 0x3FF00AE99FC77550, 997, 998),                      // 1.0026642075893797
    (
        250_000_000,
        100,
        0x3FF00DD411E4D9A3,
        24_915_882_144,
        24_915_882_145,
    ), // 1.003376073740221
    (
        18_446_744_073_709_551,
        1000,
        0x3FF4000000000000,
        14_757_395_258_967_640_800,
        14_757_395_258_967_640_800,
    ), // 1.25
    (7, 1, 0x3F40000000000000, 14_336, 14_336),                   // 2^-11, the smallest admissible
    (3, 1, 0x4008000000000000, 1, 1),                             // 3.0
    (4, 1, 0x4008000000000000, 1, 2),                             // 3.0
    (1_000_000, 100, 0x3FF33B8FCD0BFE64, 83_191_807, 83_191_808), // 1.2 * 1.001701196801074 (f64 product)
    (
        999_999,
        1000,
        0x3FE999999999999A,
        1_249_998_749,
        1_249_998_750,
    ), // 0.8
    (u64::MAX, 1, 0x433FFFFFFFFFFFFF, 2048, 2049), // 2^53 - 1, the largest admissible
    (
        5,
        100_000_000_000_000_000,
        0x3FF017682698A5D0,
        497_158_955_178_779_784,
        497_158_955_178_779_785,
    ), // 1.005714560286254
];

/// Real mainnet ScaledUiAmount multipliers read from issuer mints (2026-09-23).
const REAL: [f64; 11] = [
    1.0,
    1.0001068995219635,
    1.0009180758490996,
    1.001701196801074,
    1.0017152487959897,
    1.0026642075893797,
    1.0032690125398187,
    1.003376073740221,
    1.003909240011759,
    1.005714560286254,
    1.0094730727840426,
];

// ---------- independent references ----------

/// Big-integer decode straight from the IEEE-754 fields, for any finite
/// positive normal value: value = num / 2^den_shift (or num * 2^-den_shift).
/// Returns (numerator, denominator) as big integers.
fn reference_rational(bits: u64) -> Option<(BigUint, BigUint)> {
    let sign = bits >> 63;
    let biased = ((bits >> 52) & 0x7ff) as i64;
    let fraction = bits & 0x000f_ffff_ffff_ffff;
    if sign == 1 || biased == 0 || biased == 0x7ff {
        return None;
    }
    let significand = BigUint::from(fraction) + (BigUint::from(1u8) << 52usize);
    // value = significand * 2^(biased - 1023 - 52)
    let exponent = biased - 1075;
    if exponent >= 0 {
        Some((significand << exponent as usize, BigUint::from(1u8)))
    } else {
        Some((significand, BigUint::from(1u8) << (-exponent) as usize))
    }
}

/// f64-only decode: doubling a finite binary64 is exact, so the first power
/// of two that makes it integral gives an exact (numerator, 2^k) pair.
fn doubling_rational(value: f64) -> (u128, u32) {
    assert!(value.is_finite() && value > 0.0);
    let mut v = value;
    let mut k = 0;
    while v.fract() != 0.0 {
        v *= 2.0;
        k += 1;
    }
    assert!(v < 2f64.powi(64));
    (v as u128, k)
}

/// Whether the admissible domain accepts this multiplier: positive, normal,
/// finite and in [2^-11, 2^53), independently of the bit-shift formulation.
fn reference_admissible(bits: u64) -> bool {
    let v = f64::from_bits(bits);
    v.is_normal() && v > 0.0 && v >= 2f64.powi(-11) && v < 2f64.powi(53)
}

/// floor/ceil(units * scale / multiplier) with big rationals, and whether it
/// fits the u64 domain (including tokens = units * scale).
fn reference_raw(units: u64, scale: u64, bits: u64, up: bool) -> Option<u64> {
    if !reference_admissible(bits) {
        return None;
    }
    let tokens = BigUint::from(units) * BigUint::from(scale);
    if tokens > BigUint::from(u64::MAX) {
        return None;
    }
    let (num, den) = reference_rational(bits)?;
    // tokens / (num / den) = tokens * den / num
    let product = tokens * den;
    let quotient = &product / &num;
    let remainder = &product % &num;
    let raw = if up && remainder != BigUint::from(0u8) {
        quotient + 1u8
    } else {
        quotient
    };
    u64::try_from(raw).ok()
}

/// 4/5 <= current / listing <= 5/4 with big rationals.
fn reference_band(listing: u64, current: u64) -> Option<bool> {
    if !reference_admissible(listing) || !reference_admissible(current) {
        return None;
    }
    let (ln, ld) = reference_rational(listing)?;
    let (cn, cd) = reference_rational(current)?;
    // current/listing = cn*ld / (cd*ln)
    let ratio_num = cn * ld;
    let ratio_den = cd * ln;
    let four = BigUint::from(4u8);
    let five = BigUint::from(5u8);
    Some(&four * &ratio_num <= &five * &ratio_den && &five * &ratio_num >= &four * &ratio_den)
}

/// Deterministic 64-bit LCG (Knuth MMIX constants), high bits mixed.
struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        let x = self.0;
        x ^ (x >> 29) ^ (x << 17)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

fn bits(v: f64) -> u64 {
    v.to_bits()
}

// ---------- tests ----------

#[test]
fn golden_vectors_match_reference_and_production() {
    println!("GOLDEN_HEADER,units,scale,multiplier_bits,down,up");
    for (units, scale, multiplier, down, up) in GOLDEN {
        println!("GOLDEN,{units},{scale},0x{multiplier:016X},{down},{up}");
        assert_eq!(reference_raw(units, scale, multiplier, false), Some(down));
        assert_eq!(reference_raw(units, scale, multiplier, true), Some(up));
        assert_eq!(
            base_raw(units, scale, multiplier, false),
            Ok(down),
            "{units} {scale} {multiplier:#x}"
        );
        assert_eq!(
            base_raw(units, scale, multiplier, true),
            Ok(up),
            "{units} {scale} {multiplier:#x}"
        );
    }
    // The golden bits are exactly the Rust f64 literals of the issuer values.
    assert_eq!(GOLDEN[1].2, bits(1.001701196801074));
    assert_eq!(GOLDEN[3].2, bits(1.0017152487959897));
    assert_eq!(GOLDEN[6].2, bits(1.0094730727840426));
    assert_eq!(GOLDEN[14].2, bits(1.2 * 1.001701196801074));
    assert_eq!(GOLDEN[17].2, bits(1.005714560286254));
}

#[test]
fn unit_multiplier_is_identity() {
    assert_eq!(UNIT_MULTIPLIER, bits(1.0));
    assert_eq!(multiplier_parts(UNIT_MULTIPLIER), Ok((1 << 52, 52)));
    let mut rng = Lcg(7);
    for scale in [1, 10, 100, 1_000, 1_000_000_000, 10u64.pow(19)] {
        for units in [0, 1, 2, 999, 1_000_000, u64::MAX / scale] {
            for up in [false, true] {
                assert_eq!(
                    base_raw(units, scale, UNIT_MULTIPLIER, up),
                    units.checked_mul(scale).ok_or(Error::Overflow)
                );
            }
        }
        for _ in 0..500 {
            let units = rng.below(u64::MAX / scale);
            assert_eq!(
                base_raw(units, scale, UNIT_MULTIPLIER, false),
                Ok(units * scale)
            );
            assert_eq!(
                base_raw(units, scale, UNIT_MULTIPLIER, true),
                Ok(units * scale)
            );
        }
    }
    assert!(within_band(UNIT_MULTIPLIER, UNIT_MULTIPLIER).unwrap());
}

#[test]
fn real_issuer_multipliers_decode_exactly() {
    for value in REAL {
        let (mantissa, shift) = multiplier_parts(bits(value)).unwrap();
        assert!((1u64 << 52..1u64 << 53).contains(&mantissa));
        assert!(shift <= 63);
        // Exact: dividing by a power of two never rounds a 53-bit mantissa here.
        assert_eq!(mantissa as f64 / 2f64.powi(shift as i32), value);
        // Cross-check the rational with the f64 doubling decoder.
        let (num, k) = doubling_rational(value);
        assert_eq!(
            BigUint::from(mantissa) << k as usize,
            BigUint::from(num) << shift as usize,
            "{value}"
        );
        // And with the big-integer field decoder.
        let (rn, rd) = reference_rational(bits(value)).unwrap();
        assert_eq!(BigUint::from(mantissa) * rd, rn << shift as usize);
        // All real dividend multipliers are within the band of 1.0 and each other.
        assert!(within_band(UNIT_MULTIPLIER, bits(value)).unwrap());
        for other in REAL {
            assert!(within_band(bits(other), bits(value)).unwrap());
        }
        // Standard conversions for 8/9-decimal issuers at 6 share decimals.
        for scale in [100, 1_000] {
            for units in [1, 10, 1_000_000, 123_456_789, 10u64.pow(12)] {
                for up in [false, true] {
                    assert_eq!(
                        base_raw(units, scale, bits(value), up).ok(),
                        reference_raw(units, scale, bits(value), up)
                    );
                }
            }
        }
    }
    // Explicit decodes.
    assert_eq!(multiplier_parts(bits(2.0)), Ok((1 << 52, 51)));
    assert_eq!(multiplier_parts(bits(0.5)), Ok((1 << 52, 53)));
    assert_eq!(multiplier_parts(bits(1.25)), Ok((5 << 50, 52)));
    assert_eq!(multiplier_parts(bits(3.0)), Ok((3 << 51, 51)));
    assert_eq!(
        multiplier_parts(bits(1.001701196801074)),
        Ok((0x1006F7D589FEA9, 52))
    );
}

#[test]
fn floor_and_ceiling_differ_by_at_most_one_and_agree_when_exact() {
    let mut rng = Lcg(11);
    for _ in 0..20_000 {
        let value =
            REAL[rng.below(REAL.len() as u64) as usize] * (0.8 + rng.below(1000) as f64 / 2500.0);
        let m = bits(value);
        let scale = 10u64.pow(rng.below(4) as u32);
        let digits = 1 + rng.below(12) as u32;
        let units = rng.below(10u64.pow(digits));
        let down = base_raw(units, scale, m, false).unwrap();
        let up = base_raw(units, scale, m, true).unwrap();
        assert!(up == down || up == down + 1, "{units} {scale} {value}");
        // Exact iff tokens * 2^shift is divisible by the mantissa.
        let (mantissa, shift) = multiplier_parts(m).unwrap();
        let numerator = BigUint::from(units * scale) << shift as usize;
        let exact = &numerator % BigUint::from(mantissa) == BigUint::from(0u8);
        assert_eq!(up == down, exact);
        // Round trip: down * multiplier <= tokens <= up * multiplier (as rationals).
        let tokens = BigUint::from(units * scale) * (BigUint::from(1u8) << shift as usize);
        assert!(BigUint::from(down) * mantissa <= tokens);
        assert!(BigUint::from(up) * mantissa >= tokens);
    }
    // Exactly divisible cases.
    assert_eq!(base_raw(10, 1, bits(2.0), false), Ok(5));
    assert_eq!(base_raw(10, 1, bits(2.0), true), Ok(5));
    assert_eq!(base_raw(11, 1, bits(2.0), false), Ok(5));
    assert_eq!(base_raw(11, 1, bits(2.0), true), Ok(6));
    assert_eq!(base_raw(5, 1, bits(1.25), false), Ok(4));
    assert_eq!(base_raw(5, 1, bits(1.25), true), Ok(4));
    assert_eq!(base_raw(6, 1, bits(1.25), false), Ok(4));
    assert_eq!(base_raw(6, 1, bits(1.25), true), Ok(5));
    assert_eq!(base_raw(0, 1_000, bits(1.0094730727840426), true), Ok(0));
    assert_eq!(base_raw(3, 1, bits(0.75), false), Ok(4));
    assert_eq!(base_raw(3, 1, bits(0.75), true), Ok(4));
}

#[test]
fn conversion_is_monotone_in_quantity_and_multiplier() {
    let mut rng = Lcg(23);
    for _ in 0..5_000 {
        let scale = 10u64.pow(rng.below(4) as u32);
        let a = rng.below(10u64.pow(12));
        let b = a + rng.below(10_000);
        let m = bits(1.0 + rng.below(1 << 20) as f64 / (1u64 << 22) as f64);
        for up in [false, true] {
            assert!(base_raw(a, scale, m, up).unwrap() <= base_raw(b, scale, m, up).unwrap());
        }
        // Positive f64 bit patterns order like their values.
        let lo = 0x3FE0_0000_0000_0000 + rng.below(1 << 53);
        let hi = lo + rng.below(1 << 40);
        assert!(f64::from_bits(lo) <= f64::from_bits(hi));
        for up in [false, true] {
            let at_lo = base_raw(a, scale, lo, up).unwrap();
            let at_hi = base_raw(a, scale, hi, up).unwrap();
            assert!(
                at_hi <= at_lo,
                "larger multiplier must deliver fewer raw units"
            );
        }
        // Consecutive share units never skip backwards and add at most ceil(scale/m).
        let d0 = base_raw(a, scale, m, false).unwrap();
        let d1 = base_raw(a + 1, scale, m, false).unwrap();
        assert!(d1 >= d0 && d1 - d0 <= scale + 1);
    }
}

#[test]
fn overflow_is_rejected_not_wrapped() {
    // units * scale exceeds u64 even at multiplier 1.0.
    assert_eq!(
        base_raw(u64::MAX, 10, UNIT_MULTIPLIER, false),
        Err(Error::Overflow)
    );
    assert_eq!(
        base_raw(u64::MAX / 10 + 1, 10, UNIT_MULTIPLIER, true),
        Err(Error::Overflow)
    );
    assert_eq!(
        base_raw(2, 10u64.pow(19), UNIT_MULTIPLIER, false),
        Err(Error::Overflow)
    );
    assert_eq!(
        base_raw(u64::MAX / 10, 10, UNIT_MULTIPLIER, false),
        Ok(u64::MAX / 10 * 10)
    );
    // The raw result exceeds u64 below a multiplier of one.
    assert_eq!(
        base_raw(u64::MAX, 1, bits(0.5), false),
        Err(Error::Overflow)
    );
    assert_eq!(
        base_raw(u64::MAX / 2 + 1, 1, bits(0.5), false),
        Err(Error::Overflow)
    );
    assert_eq!(
        base_raw(u64::MAX / 2, 1, bits(0.5), false),
        Ok(u64::MAX - 1)
    );
    assert_eq!(
        base_raw(u64::MAX, 1, bits(2f64.powi(-11)), true),
        Err(Error::Overflow)
    );
    // Rounding up across the u64 boundary is rejected too: tokens = 2^64 - 1
    // at 1 - 2^-53 gives just above 2^64 - 1.
    let below_one = bits(1.0) - 1;
    assert_eq!(
        base_raw(u64::MAX, 1, below_one, false),
        reference_raw(u64::MAX, 1, below_one, false).ok_or(Error::Overflow)
    );
    assert_eq!(base_raw(u64::MAX, 1, below_one, true), Err(Error::Overflow));
    assert_eq!(reference_raw(u64::MAX, 1, below_one, true), None);
    // Largest inputs at the largest shift stay exact (no 128-bit wrap).
    let smallest = bits(2f64.powi(-11));
    let units = u64::MAX >> 11;
    assert_eq!(base_raw(units, 1, smallest, false), Ok(units << 11));
}

#[test]
fn invalid_multipliers_are_rejected() {
    let invalid = [
        0u64,                        // +0.0
        bits(-0.0),                  // -0.0
        bits(-1.0),                  // negative
        bits(-1.001701196801074),    // negative real value
        1,                           // smallest subnormal
        0x000F_FFFF_FFFF_FFFF,       // largest subnormal
        bits(f64::MIN_POSITIVE) - 1, // largest subnormal (same, by construction)
        bits(f64::NAN),
        0x7FF0_0000_0000_0001, // signalling NaN
        0xFFF8_0000_0000_0000, // negative NaN
        bits(f64::INFINITY),
        bits(f64::NEG_INFINITY),
        bits(f64::MAX),
        bits(f64::MIN_POSITIVE), // normal, but shift > 63
        bits(2f64.powi(53)),     // shift -1
        bits(1e300),
        bits(1e-300),
        bits(2f64.powi(-11)) - 1, // just below the smallest admissible value
        u64::MAX,
    ];
    for m in invalid {
        assert_eq!(multiplier_parts(m), Err(Error::InvalidTerms), "{m:#x}");
        assert!(!reference_admissible(m), "{m:#x}");
        assert_eq!(base_raw(1, 1, m, false), Err(Error::InvalidTerms));
        assert_eq!(base_raw(0, 1, m, true), Err(Error::InvalidTerms));
        assert_eq!(within_band(m, UNIT_MULTIPLIER), Err(Error::InvalidTerms));
        assert_eq!(within_band(UNIT_MULTIPLIER, m), Err(Error::InvalidTerms));
    }
    // Shift boundaries: exactly 0 and exactly 63 are accepted.
    assert_eq!(multiplier_parts(bits(2f64.powi(52))), Ok((1 << 52, 0)));
    assert_eq!(
        multiplier_parts(bits(2f64.powi(53)) - 1),
        Ok(((1 << 53) - 1, 0))
    );
    assert_eq!(multiplier_parts(bits(2f64.powi(-11))), Ok((1 << 52, 63)));
    // Every biased exponent: accepted exactly for shifts 0..=63.
    for exponent in 0u64..0x800 {
        for fraction in [0u64, 1, 0x000F_FFFF_FFFF_FFFF] {
            let m = (exponent << 52) | fraction;
            let shift = 1075i64 - exponent as i64;
            let accepted = exponent != 0 && exponent != 0x7ff && (0..=63).contains(&shift);
            assert_eq!(multiplier_parts(m).is_ok(), accepted, "exponent {exponent}");
            assert_eq!(reference_admissible(m), accepted, "exponent {exponent}");
            assert!(multiplier_parts(m | 1 << 63).is_err());
        }
    }
}

#[test]
fn dividend_band_edges_are_inclusive_and_exact() {
    let b = bits;
    // Exactly 5/4 and 4/5 (representable pairs) are inside.
    assert_eq!(within_band(b(1.0), b(1.25)), Ok(true));
    assert_eq!(within_band(b(1.25), b(1.0)), Ok(true));
    assert_eq!(within_band(b(4.0), b(5.0)), Ok(true));
    assert_eq!(within_band(b(5.0), b(4.0)), Ok(true));
    assert_eq!(within_band(b(0.8), b(1.0)), Ok(true)); // 1/0.8f64 < 5/4
                                                       // One ulp outside either edge is out.
    assert_eq!(within_band(b(1.0), b(1.25) + 1), Ok(false));
    assert_eq!(within_band(b(1.25), b(1.0) - 1), Ok(false));
    assert_eq!(within_band(b(4.0), b(5.0) + 1), Ok(false));
    assert_eq!(within_band(b(5.0), b(4.0) - 1), Ok(false));
    // And one ulp inside is in.
    assert_eq!(within_band(b(1.0), b(1.25) - 1), Ok(true));
    assert_eq!(within_band(b(1.25), b(1.0) + 1), Ok(true));
    // 0.8f64 is slightly above 4/5, and its predecessor below it.
    assert_eq!(within_band(b(1.0), b(0.8)), Ok(true));
    assert_eq!(within_band(b(1.0), b(0.8) - 1), Ok(false));
    // Exact 4/5 at a real listing multiplier, via big rationals.
    let listing = b(1.001701196801074);
    for current in [b(1.001701196801074 * 1.25), b(1.001701196801074 * 0.8)] {
        for delta in [-2i64, -1, 0, 1, 2] {
            let m = (current as i64 + delta) as u64;
            assert_eq!(
                within_band(listing, m).ok(),
                reference_band(listing, m),
                "{delta}"
            );
        }
    }
    // Stock splits and reverse splits leave the band.
    for listing in REAL {
        for factor in [2.0, 3.0, 10.0, 0.5, 0.1, 1.0 / 3.0, 1.3, 0.75] {
            assert_eq!(
                within_band(b(listing), b(listing * factor)),
                Ok(false),
                "{listing} x{factor}"
            );
        }
        for factor in [1.2, 0.85, 1.0, 1.1, 0.9, 1.249] {
            assert_eq!(
                within_band(b(listing), b(listing * factor)),
                Ok(true),
                "{listing} x{factor}"
            );
        }
    }
    // Extreme but admissible shifts do not overflow the comparison.
    assert_eq!(
        within_band(b(2f64.powi(-11)), b(2f64.powi(53)) - 1),
        Ok(false)
    );
    assert_eq!(
        within_band(b(2f64.powi(53)) - 1, b(2f64.powi(-11))),
        Ok(false)
    );
    assert_eq!(within_band(b(2f64.powi(-11)), b(2f64.powi(-11))), Ok(true));
    assert_eq!(
        within_band(b(2f64.powi(53)) - 1, b(2f64.powi(53)) - 1),
        Ok(true)
    );
}

#[test]
fn pseudo_random_properties_match_big_rational_reference() {
    let mut rng = Lcg(0x5EED_CAFE);
    let mut exact = 0;
    let mut rejected = 0;
    for i in 0..60_000 {
        // Multipliers: half near real dividend values, half anywhere in (and
        // around) the admissible exponent range, including invalid encodings.
        let multiplier = match i % 4 {
            0 => bits(REAL[rng.below(REAL.len() as u64) as usize]) + rng.below(1 << 12) - (1 << 11),
            1 => bits(1.0) - (1 << 51) + rng.below(1 << 53),
            2 => ((1000 + rng.below(90)) << 52) | rng.below(1 << 52),
            _ => rng.next(),
        };
        let scale = if rng.below(8) == 0 {
            rng.next() >> rng.below(64)
        } else {
            10u64.pow(rng.below(20) as u32)
        };
        let units = match rng.below(4) {
            0 => rng.below(1_000),
            1 => rng.below(10u64.pow(9)),
            2 => rng.next() >> rng.below(64),
            _ => u64::MAX / scale.max(1) - rng.below(3).min(u64::MAX / scale.max(1)),
        };
        for up in [false, true] {
            let expected = if multiplier_parts(multiplier).is_err() {
                assert!(!reference_admissible(multiplier), "{multiplier:#x}");
                Err(Error::InvalidTerms)
            } else {
                reference_raw(units, scale, multiplier, up).ok_or(Error::Overflow)
            };
            let actual = base_raw(units, scale, multiplier, up);
            assert_eq!(
                actual, expected,
                "units {units} scale {scale} m {multiplier:#x} up {up}"
            );
            match actual {
                Ok(_) => exact += 1,
                Err(_) => rejected += 1,
            }
        }
        // Band against a second random multiplier near the first.
        let other = if rng.below(2) == 0 {
            multiplier
                .wrapping_add(rng.below(1 << 51))
                .wrapping_sub(1 << 50)
        } else {
            rng.next()
        };
        let expected = reference_band(multiplier, other);
        assert_eq!(
            within_band(multiplier, other).ok(),
            expected,
            "{multiplier:#x} {other:#x}"
        );
        if let Some(inside) = expected {
            // Symmetric: 4/5 <= r <= 5/4 iff 4/5 <= 1/r <= 5/4.
            assert_eq!(within_band(other, multiplier), Ok(inside));
        }
    }
    // The loop must have exercised both the valid and rejected domains.
    assert!(exact > 50_000 && rejected > 10_000, "{exact} {rejected}");
}
