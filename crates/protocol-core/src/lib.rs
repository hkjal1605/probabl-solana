//! Deterministic raw-unit rules shared by the Solana handlers and invariant tests.
//! Amounts fit SPL Token's u64 domain; prices retain the source's u128 ratio domain.

pub const WAD: u128 = 1_000_000_000_000_000_000;
pub const BPS: u16 = 10_000;
pub const MAX_FEE_BPS: u16 = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Overflow,
    InvalidTerms,
    InvalidFee,
    InvalidState,
    Expired,
    InvalidNonce,
    CapExceeded,
    InvalidFill,
    StaleQuote,
    FractionalRedemption,
}
pub type Result<T> = core::result::Result<T, Error>;

/// Decompose the price before multiplication. This supports the full u128 price
/// domain without a lossy cast or a 192-bit intermediate. Anything rejected for
/// overflow necessarily exceeds the u64 token amount domain.
pub fn quote_down(quantity: u64, price: u128) -> Result<u64> {
    let integer = (quantity as u128)
        .checked_mul(price / WAD)
        .ok_or(Error::Overflow)?;
    let fraction = (quantity as u128) * (price % WAD);
    let amount = integer.checked_add(fraction / WAD).ok_or(Error::Overflow)?;
    u64::try_from(amount).map_err(|_| Error::Overflow)
}

pub fn quote_up(quantity: u64, price: u128) -> Result<u64> {
    let down = quote_down(quantity, price)?;
    let remainder = (quantity as u128) * (price % WAD) % WAD;
    down.checked_add(u64::from(remainder != 0))
        .ok_or(Error::Overflow)
}

pub fn fee(gross: u64, rate: u16, carry: u16) -> Result<(u64, u16)> {
    if rate > MAX_FEE_BPS || carry >= BPS {
        return Err(Error::InvalidFee);
    }
    let numerator = (gross as u128) * (rate as u128) + carry as u128;
    Ok((
        (numerator / BPS as u128) as u64,
        (numerator % BPS as u128) as u16,
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Caps {
    pub step: u64,
    pub tick: u128,
    pub min_notional: u64,
    pub max_quantity: u64,
    pub max_order: u64,
    pub max_wallet: u64,
    pub max_market: u64,
}

impl Caps {
    pub fn validate(&self) -> Result<()> {
        if self.step == 0
            || self.tick == 0
            || self.min_notional == 0
            || self.max_quantity < self.step
            || self.max_order < self.min_notional
            || self.max_wallet < self.max_order
            || self.max_market < self.max_wallet
        {
            return Err(Error::InvalidTerms);
        }
        if quote_down(self.step, self.tick)? == 0 {
            return Err(Error::InvalidTerms);
        }
        // quote_down above proves that step * tick fits u128.
        let denominator = (self.step as u128)
            .checked_mul(self.tick)
            .ok_or(Error::Overflow)?;
        let ticks = ((self.min_notional - 1) as u128 * WAD) / denominator + 1;
        let minimum_price = ticks.checked_mul(self.tick).ok_or(Error::Overflow)?;
        let notional = quote_up(self.step, minimum_price)?;
        if notional > self.max_order || (notional as u128) * 2 > self.max_market as u128 {
            return Err(Error::CapExceeded);
        }
        Ok(())
    }

    pub fn validate_order(&self, quantity: u64, price: u128) -> Result<u64> {
        if self.step == 0
            || self.tick == 0
            || quantity == 0
            || price == 0
            || !quantity.is_multiple_of(self.step)
            || !price.is_multiple_of(self.tick)
            || quantity > self.max_quantity
        {
            return Err(Error::InvalidTerms);
        }
        let notional = quote_up(quantity, price)?;
        if notional < self.min_notional || notional > self.max_order {
            return Err(Error::CapExceeded);
        }
        Ok(notional)
    }

    pub fn final_exposure(&self, wallet: u128, market: u128) -> Result<()> {
        if wallet > market || wallet > self.max_wallet as u128 || market > self.max_market as u128 {
            return Err(Error::CapExceeded);
        }
        Ok(())
    }
}

pub const SCHEDULED: u8 = 1;
pub const OPEN: u8 = 2;
pub const FROZEN: u8 = 3;
pub const AWAITING: u8 = 4;
pub const REDEEMABLE: u8 = 6;
pub const ARCHIVED: u8 = 7;

pub fn trading(state: u8, paused: bool, now: i64, open: i64, cutoff: i64) -> Result<()> {
    if state != OPEN || paused || now < open || now >= cutoff {
        return Err(Error::InvalidState);
    }
    Ok(())
}

pub fn valid_expiry(now: i64, expiry: i64, cutoff: i64) -> Result<()> {
    if expiry <= now || expiry > cutoff {
        return Err(Error::Expired);
    }
    Ok(())
}

pub fn valid_nonce(nonce: u64, minimum: u64) -> Result<()> {
    if nonce < minimum {
        return Err(Error::InvalidNonce);
    }
    Ok(())
}

pub fn payout(yes: u8, no: u8) -> Result<u8> {
    match (yes, no) {
        (1, 0) | (0, 1) => Ok(1),
        (1, 1) => Ok(2),
        _ => Err(Error::InvalidTerms),
    }
}

/// Sum the weighted claims BEFORE division. Refuse to destroy a fractional raw
/// unit: during INVALID, burn an even total or retain/combine the odd claim.
/// In particular, (1 YES, 1 NO) returns 1, and (1 YES, 0 NO) is not burned.
pub fn redemption(yes_amount: u64, no_amount: u64, yes: u8, no: u8) -> Result<u64> {
    let denominator = payout(yes, no)? as u128;
    let numerator = yes_amount as u128 * yes as u128 + no_amount as u128 * no as u128;
    if !numerator.is_multiple_of(denominator) {
        return Err(Error::FractionalRedemption);
    }
    u64::try_from(numerator / denominator).map_err(|_| Error::Overflow)
}

/// Outstanding *total mint supply*, including external holders. Ceiling is
/// conservative for fractional claims and post-resolution complete-set merges.
pub fn claim_backing(yes_supply: u64, no_supply: u64, payouts: Option<(u8, u8)>) -> Result<u64> {
    match payouts {
        None => Ok(yes_supply.max(no_supply)),
        Some((yes, no)) => {
            let denominator = payout(yes, no)? as u128;
            let numerator = yes_supply as u128 * yes as u128 + no_supply as u128 * no as u128;
            u64::try_from(numerator.div_ceil(denominator)).map_err(|_| Error::Overflow)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fill {
    pub quote: u64,
    pub buyer_remaining: u64,
    pub seller_remaining: u64,
    pub buyer_reserved: u64,
    pub improvement: u64,
    pub buyer_notional_reduction: u64,
    pub seller_notional_reduction: u64,
}

#[allow(clippy::too_many_arguments)]
pub fn fill(
    quantity: u64,
    step: u64,
    buyer_remaining: u64,
    seller_remaining: u64,
    bid: u128,
    ask: u128,
    bid_is_maker: bool,
) -> Result<Fill> {
    if quantity == 0
        || step == 0
        || !quantity.is_multiple_of(step)
        || quantity > buyer_remaining
        || quantity > seller_remaining
        || ask == 0
        || bid < ask
    {
        return Err(Error::InvalidFill);
    }
    let quote = quote_down(quantity, if bid_is_maker { bid } else { ask })?;
    if quote == 0 {
        return Err(Error::InvalidFill);
    }
    let buyer_reserved = quote_up(buyer_remaining - quantity, bid)?;
    let buyer_notional_reduction = quote_up(buyer_remaining, bid)?
        .checked_sub(buyer_reserved)
        .ok_or(Error::InvalidFill)?;
    let improvement = buyer_notional_reduction
        .checked_sub(quote)
        .ok_or(Error::InvalidFill)?;
    let seller_notional_reduction = quote_up(seller_remaining, ask)?
        .checked_sub(quote_up(seller_remaining - quantity, ask)?)
        .ok_or(Error::InvalidFill)?;
    Ok(Fill {
        quote,
        buyer_remaining: buyer_remaining - quantity,
        seller_remaining: seller_remaining - quantity,
        buyer_reserved,
        improvement,
        buyer_notional_reduction,
        seller_notional_reduction,
    })
}

pub fn guard(
    now: i64,
    deadline: i64,
    expiry: i64,
    quoted: (u64, u16, u16),
    actual: (u64, u16, u16),
) -> Result<()> {
    if now >= deadline || deadline > expiry || quoted != actual {
        return Err(Error::StaleQuote);
    }
    Ok(())
}

/// A frozen/closed market, expired order, or invalidated nonce can always be released.
/// Pausing trading alone does not authorize a third party to cancel live orders.
pub fn releasable(state: u8, now: i64, expiry: i64, nonce: u64, minimum: u64) -> bool {
    state != OPEN || now >= expiry || nonce < minimum
}
