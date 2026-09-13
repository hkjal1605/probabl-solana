/** Public read-only Polymarket adapter smoke. No orders, accounts, or credentials. */
import {
  normalizeGammaMarket,
  PolymarketYesBook,
  yesOutcome,
} from "@conditional-stocks/market-data";
import { OfficialPolymarketSource } from "../src/source.ts";

const source = new OfficialPolymarketSource(
  "https://gamma-api.polymarket.com",
  "https://clob.polymarket.com",
  "wss://ws-subscriptions-clob.polymarket.com/ws/market",
);
const response = await fetch(
  "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&order=volume24hr&ascending=false",
  { signal: AbortSignal.timeout(15_000) },
);
if (!response.ok) throw new Error(`Gamma discovery returned ${response.status}`);
const candidates = (await response.json()) as unknown[];
let chosen: ReturnType<typeof normalizeGammaMarket> | undefined;
let book: PolymarketYesBook | undefined;
for (const candidate of candidates) {
  try {
    const market = normalizeGammaMarket(candidate);
    const token = yesOutcome(market);
    const next = new PolymarketYesBook(market.conditionId, token.tokenId, {
      staleAfterMs: 30_000n,
      standardNotionalX6: 100_000_000n,
    });
    next.applySnapshot(await source.getBook(token.tokenId));
    chosen = market;
    book = next;
    break;
  } catch {
    /* Only supported binary non-negative-risk markets are eligible. */
  }
}
if (!chosen || !book) throw new Error("No supported live market with a readable order book");
const market = normalizeGammaMarket(await source.getMarket(chosen.gammaMarketId));
if (market.mappingHash !== chosen.mappingHash)
  throw new Error("Gamma mapping changed during smoke");
let events = 0;
const qualities = new Set([book.tick().quality]);
const activeBook = book;
await new Promise<void>((resolve, reject) => {
  const socket = source.connect(
    [yesOutcome(market).tokenId],
    (event) => {
      try {
        const result = activeBook.applyWebSocket(event);
        if (result.applied) {
          events++;
          if (result.tick) qualities.add(result.tick.quality);
        }
      } catch (error) {
        clearTimeout(timer);
        socket.close();
        reject(error);
      }
    },
    (reason) => {
      clearTimeout(timer);
      socket.close();
      reject(new Error(reason));
    },
  );
  // Includes two heartbeat exchanges as well as the initial upstream snapshot.
  const timer = setTimeout(() => {
    socket.close();
    if (events === 0) reject(new Error("No usable upstream WebSocket events"));
    else resolve();
  }, 25_000);
});
console.info(
  JSON.stringify(
    {
      completed: true,
      checkedAt: new Date().toISOString(),
      gammaMarketId: market.gammaMarketId,
      conditionId: market.conditionId,
      question: market.question,
      sourceEvents: events,
      qualities: [...qualities],
      transactionsSubmitted: 0,
    },
    null,
    2,
  ),
);
