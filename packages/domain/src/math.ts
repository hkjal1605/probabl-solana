export const WAD = 10n ** 18n;

const requireNonNegative = (value: bigint, name: string): void => {
  if (value < 0n) {
    throw new RangeError(`${name} must be non-negative`);
  }
};

export const mulDivDown = (x: bigint, y: bigint, denominator: bigint): bigint => {
  requireNonNegative(x, "x");
  requireNonNegative(y, "y");

  if (denominator <= 0n) {
    throw new RangeError("denominator must be positive");
  }

  return (x * y) / denominator;
};

export const mulDivUp = (x: bigint, y: bigint, denominator: bigint): bigint => {
  requireNonNegative(x, "x");
  requireNonNegative(y, "y");

  if (denominator <= 0n) {
    throw new RangeError("denominator must be positive");
  }

  const product = x * y;
  return product === 0n ? 0n : (product - 1n) / denominator + 1n;
};

export const quoteForExecution = (quantity: bigint, priceRawX18: bigint): bigint =>
  mulDivDown(quantity, priceRawX18, WAD);

export const quoteForReservation = (quantity: bigint, priceRawX18: bigint): bigint =>
  mulDivUp(quantity, priceRawX18, WAD);
