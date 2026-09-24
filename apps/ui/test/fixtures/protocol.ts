/** Synthetic test responses only. Never imported by application runtime code. */
import type {
  BookLevel,
  IndexedOrder,
  MarketLegView,
  MarketView,
  PositionView,
  TradeView,
} from "../../src/types/api";
export const fixtureAccount = "0xde00000000000000000000000000000000000001";
/** Deterministic base58 fixture mints (32 repeated bytes 1..12). */
export const FIXTURE_MINTS = {
  legX: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
  quote: "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR",
  legOn: "CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8",
  legR: "GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq",
  quoteYes: "LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY",
  quoteNo: "QWmroo4YnnMqYW3cnxWkFdaTxGD3P7vMSzwMHGbUzwF",
  legXYes: "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx",
  legXNo: "YMN9Qj5jPNp7j14VPcML1B6xGgcPWVZUGLFU3Mnyfaf",
  legOnYes: "cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN",
  legOnNo: "gBxS1f6uyyGPuW5MzGBukidSb71jdsCb5fZaoSzULE5",
  legRYes: "k7FaK87WHGVXzkaoHb7CdVPgkKDQhZ29VLDeBVbDfYn",
  legRNo: "p2Yicb86aZig616Eav2VWG9vuXR5mEqhtzshZYBxzsV",
} as const;
/** f64 bits of 1.0 and 1.0017 (a reinvested dividend inside the band). */
export const UNIT_BITS = "4607182418800017408";
export const DIVIDEND_BITS = "4607190074919383938";
const M = FIXTURE_MINTS;
export const fixtureLegs: MarketLegView[] = [
  {
    collateral: 1,
    bit: 1,
    mint: M.legX,
    decimals: 8,
    scale: "100",
    listingMultiplier: UNIT_BITS,
    active: true,
    ready: true,
    claimMints: { yes: M.legXYes, no: M.legXNo },
    live: {
      multiplier: DIVIDEND_BITS,
      multiplierValue: 1.0017,
      paused: false,
      vaultFrozen: false,
      tradable: true,
      halt: null,
    },
    symbol: "NVDAx",
    issuer: "xStocks",
  },
  {
    collateral: 2,
    bit: 2,
    mint: M.legOn,
    decimals: 9,
    scale: "1000",
    listingMultiplier: UNIT_BITS,
    active: true,
    ready: true,
    claimMints: { yes: M.legOnYes, no: M.legOnNo },
    symbol: "NVDAon",
    issuer: "Ondo Global Markets",
  },
  {
    collateral: 3,
    bit: 4,
    mint: M.legR,
    decimals: 9,
    scale: "1000",
    listingMultiplier: UNIT_BITS,
    active: true,
    ready: true,
    claimMints: { yes: M.legRYes, no: M.legRNo },
    live: {
      multiplier: UNIT_BITS,
      multiplierValue: 1,
      paused: true,
      vaultFrozen: false,
      tradable: false,
      halt: "issuer-paused",
    },
    symbol: "NVDAr",
    issuer: "Remora",
  },
];
/** Level with a per-issuer breakdown; `parts` are [mask, shares]. */
const level = (price: string, parts: [number, number][]): BookLevel => ({
  priceExact: price,
  price: Number(price),
  quantity: parts.reduce((sum, [, quantity]) => sum + quantity, 0),
  byBases: parts.map(([mask, quantity]) => ({
    mask,
    quantity,
    quantityRaw: String(Math.round(quantity * 1_000_000)),
  })),
});
export const fixtureMarkets: MarketView[] = [
  {
    shareDecimals: 6,
    quoteTokenDecimals: 6,
    protocolVersion: 3,
    priceFormat: "share-unit-ratio-x18",
    baseStep: "1000",
    bases: fixtureLegs,
    claimMints: [
      M.quote,
      M.quoteYes,
      M.quoteNo,
      M.legX,
      M.legXYes,
      M.legXNo,
      M.legOn,
      M.legOnYes,
      M.legOnNo,
      M.legR,
      M.legRYes,
      M.legRNo,
    ],
    quoteClaimMints: { yes: M.quoteYes, no: M.quoteNo },
    assetKey: "asset:NVDA",
    cutoff: "2027-01-15T08:20:00.000Z",
    description: "Test fixture only.",
    eventImpact: 37.400000000000034,
    id: "0x0000000000000000000000000000000000000000000000000000000000dead01",
    lifecycle: "open",
    mapping: {
      conditionId: "0x0000000000000000000000000000000000000000000000000000000000beef01",
      noIndex: "2",
      polymarketUrl:
        "/resolution?market=0x0000000000000000000000000000000000000000000000000000000000dead01#evidence-0x0000000000000000000000000000000000000000000000000000000000dead01",
      yesIndex: "1",
    },
    no: {
      bids: [
        level("216.95", [[7, 2]]),
        level("216.35", [
          [1, 1],
          [3, 2],
        ]),
        level("215.75", [[2, 4]]),
      ],
      asks: [
        level("217.85", [[1, 2]]),
        level("218.45", [[2, 3]]),
        level("219.05", [
          [1, 1],
          [2, 3],
        ]),
      ],
      bestBid: 216.95,
      bestAsk: 217.85,
      bestBidExact: "216.95",
      bestAskExact: "217.85",
      spread: 0.9000000000000057,
      depthUsd: 3913.2,
    },
    ordinaryReference: 236.82,
    probability: {
      ask: 0.58,
      bid: 0.56,
      value: 0.57,
      quality: "valid",
      observedAt: "2027-01-15T08:00:00.000Z",
    },
    question: "Is the test condition met?",
    quoteToken: M.quote,
    residual: null,
    ticker: "NVDA",
    tradingOpen: "2027-01-15T07:59:00.000Z",
    yes: {
      bids: [
        level("254.35", [[7, 2]]),
        level("253.75", [[1, 3]]),
        level("253.15", [
          [2, 1],
          [6, 3],
        ]),
      ],
      asks: [
        level("255.25", [[2, 1]]),
        level("255.85", [[1, 3]]),
        level("256.45", [
          [1, 1],
          [2, 3],
        ]),
        level("280", [[4, 1]]),
      ],
      bestBid: 254.35,
      bestAsk: 255.25,
      bestBidExact: "254.35",
      bestAskExact: "255.25",
      spread: 0.9000000000000057,
      depthUsd: 4611.150000000001,
    },
  },
];
export const fixtureState: {
  orders: IndexedOrder[];
  trades: TradeView[];
  positions: PositionView[];
  balances: Record<string, string>;
} = {
  orders: [
    {
      maker: "0xde00000000000000000000000000000000000001",
      marketId: "0x0000000000000000000000000000000000000000000000000000000000dead01",
      branch: 0,
      side: 0,
      fundingKind: 0,
      tif: 0,
      bases: 7,
      quantity: "1000000",
      limitPriceRawX18: "256000000000000000000",
      expiry: "1800001199",
      maxFeeBps: 0,
      id: "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
      filled: "1000000",
      remaining: "0",
      reserved: "0",
      status: "filled",
      confirmation: "confirmed",
      updatedBlock: "0",
    },
  ],
  trades: [
    {
      id: "0xa2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2",
      marketId: "0x0000000000000000000000000000000000000000000000000000000000dead01",
      branch: 0,
      fillQuantity: "1000000",
      executionPriceRawX18: "255250000000000000000",
      base: 2,
      baseAmount: "1000000000",
      blockTimestamp: "1800000000",
      transactionHash: "0xabababababababababababababababababababababababababababababababab",
    },
  ],
  positions: [
    {
      marketId: "0x0000000000000000000000000000000000000000000000000000000000dead01",
      conditionId: "0x0000000000000000000000000000000000000000000000000000000000beef01",
      shareDecimals: 6,
      quoteTokenDecimals: 6,
      protocolVersion: 3,
      bases: [
        { collateral: 1, mint: M.legX, decimals: 8, yes: "500000000", no: "500000000" },
        { collateral: 2, mint: M.legOn, decimals: 9, yes: "2000000000", no: "0" },
        { collateral: 3, mint: M.legR, decimals: 9, yes: "0", no: "0" },
      ],
      quoteYes: "1000000000",
      quoteNo: "1255250000",
      redeemable: false,
    },
  ],
  balances: {
    [M.legX]: "10000000000",
    [M.quote]: "99744750000",
    [M.legOn]: "100000000000",
    [M.legR]: "100000000000",
  },
};
