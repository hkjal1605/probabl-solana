export const gammaMarket = (overrides: Record<string, unknown> = {}) => ({
  active: true,
  clobTokenIds: JSON.stringify(["111", "222"]),
  closed: false,
  conditionId: `0x${"12".repeat(32)}`,
  description: "This market resolves Yes if the stated event occurs.",
  endDate: "2027-01-01T00:00:00Z",
  id: "gamma-42",
  negRisk: false,
  outcomes: JSON.stringify(["Yes", "No"]),
  question: "Will the event occur?",
  resolutionSource: "Official publication",
  slug: "will-the-event-occur",
  umaResolutionStatus: "unresolved",
  ...overrides,
});

export const bookSnapshot = (overrides: Record<string, unknown> = {}) => ({
  asks: [
    { price: "0.52", size: "400" },
    { price: "0.53", size: "100" },
  ],
  asset_id: "111",
  bids: [
    { price: "0.48", size: "400" },
    { price: "0.47", size: "100" },
  ],
  hash: "snapshot-1",
  market: `0x${"12".repeat(32)}`,
  timestamp: "1767225600000",
  ...overrides,
});
