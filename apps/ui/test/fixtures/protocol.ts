/** Synthetic test responses only. Never imported by application runtime code. */
import type { IndexedOrder, MarketView, PositionView, TradeView } from "../../src/types/api";
export const fixtureAccount = "0xde00000000000000000000000000000000000001";
export const fixtureMarkets: MarketView[] = [
  {
    baseTokenDecimals: 18,
    quoteTokenDecimals: 6,
    protocolVersion: 2,
    priceFormat: "raw-unit-ratio-x18",
    baseStep: "1000000000000000",
    baseToken: "0x1111111111111111111111111111111111111111",
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
        {
          priceExact: "216.95",
          price: 216.95,
          quantity: 2,
        },
        {
          priceExact: "216.35",
          price: 216.35,
          quantity: 3,
        },
        {
          priceExact: "215.75",
          price: 215.75,
          quantity: 4,
        },
      ],
      asks: [
        {
          priceExact: "217.85",
          price: 217.85,
          quantity: 2,
        },
        {
          priceExact: "218.45",
          price: 218.45,
          quantity: 3,
        },
        {
          priceExact: "219.05",
          price: 219.05,
          quantity: 4,
        },
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
    quoteToken: "0x2222222222222222222222222222222222222222",
    residual: null,
    ticker: "NVDA",
    tradingOpen: "2027-01-15T07:59:00.000Z",
    yes: {
      bids: [
        {
          priceExact: "254.35",
          price: 254.35,
          quantity: 2,
        },
        {
          priceExact: "253.75",
          price: 253.75,
          quantity: 3,
        },
        {
          priceExact: "253.15",
          price: 253.15,
          quantity: 4,
        },
      ],
      asks: [
        {
          priceExact: "255.25",
          price: 255.25,
          quantity: 1,
        },
        {
          priceExact: "255.85",
          price: 255.85,
          quantity: 3,
        },
        {
          priceExact: "256.45",
          price: 256.45,
          quantity: 4,
        },
        {
          priceExact: "280",
          price: 280,
          quantity: 1,
        },
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
      quantity: "1000000000000000000",
      limitPriceRawX18: "256000000",
      expiry: "1800001199",
      maxFeeBps: 0,
      id: "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
      filled: "1000000000000000000",
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
      fillQuantity: "1000000000000000000",
      executionPriceRawX18: "255250000",
      blockTimestamp: "1800000000",
      transactionHash: "0xabababababababababababababababababababababababababababababababab",
    },
  ],
  positions: [
    {
      marketId: "0x0000000000000000000000000000000000000000000000000000000000dead01",
      conditionId: "0x0000000000000000000000000000000000000000000000000000000000beef01",
      baseTokenDecimals: 18,
      quoteTokenDecimals: 6,
      protocolVersion: 2,
      priceFormat: "raw-unit-ratio-x18",
      stockYes: "5000000000000000000",
      stockNo: "5000000000000000000",
      quoteYes: "1000000000",
      quoteNo: "1255250000",
      redeemable: false,
    },
  ],
  balances: {
    "0x1111111111111111111111111111111111111111": "100000000000000000000",
    "0x2222222222222222222222222222222222222222": "99744750000",
    "0x3333333333333333333333333333333333333333": "100000000000000000000",
    "0x4444444444444444444444444444444444444444": "100000000000000000000",
  },
};
