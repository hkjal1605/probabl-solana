import type { PolymarketSocket, PolymarketSource } from "../src/source.ts";

export const conditionId = `0x${"12".repeat(32)}` as const;

export const gammaMarket = (overrides: Record<string, unknown> = {}) => ({
  active: true,
  clobTokenIds: '["111","222"]',
  closed: false,
  conditionId,
  description: "Binary rules",
  endDate: "2027-01-01T00:00:00Z",
  id: "42",
  negRisk: false,
  outcomes: '["Yes","No"]',
  question: "Will it happen?",
  resolutionSource: "Official source",
  slug: "will-it-happen",
  ...overrides,
});

export const book = (overrides: Record<string, unknown> = {}) => ({
  asks: [{ price: "0.52", size: "500" }],
  asset_id: "111",
  bids: [{ price: "0.48", size: "500" }],
  hash: "rest-1",
  market: conditionId,
  timestamp: Date.now().toString(),
  ...overrides,
});

export class FakeSource implements PolymarketSource {
  bookCalls = 0;
  currentBook: unknown = book();
  currentMarket: unknown = gammaMarket();
  onDisconnect: ((reason: string) => void) | null = null;
  onEvent: ((event: unknown) => void) | null = null;

  connect(
    _tokenIds: string[],
    onEvent: (event: unknown) => void,
    onDisconnect: (reason: string) => void,
  ): PolymarketSocket {
    this.onEvent = onEvent;
    this.onDisconnect = onDisconnect;
    return { close: () => undefined };
  }

  async getBook(_tokenId: string): Promise<unknown> {
    this.bookCalls += 1;
    return this.currentBook;
  }

  async getMarket(_gammaMarketId: string): Promise<unknown> {
    return this.currentMarket;
  }
}

export const environment = {
  clobUrl: "https://clob.polymarket.com",
  gammaUrl: "https://gamma-api.polymarket.com",
  host: "127.0.0.1",
  internalToken: "test-internal-token",
  metadataPollMs: 60_000,
  port: 42_073,
  reconcileMs: 60_000,
  staleAfterMs: 30_000n,
  standardNotionalX6: 100_000_000n,
  websocketUrl: "wss://example.invalid/ws",
} as const;
