import { serverApi } from "@/lib/api/server";
import { MarketWorkspace } from "./components/MarketWorkspace";
export async function MarketDetailPageModule({ marketId }: { marketId: string }) {
  const [markets, trades] = await Promise.all([serverApi.markets(), serverApi.trades(marketId)]);
  return <MarketWorkspace marketId={marketId} initialMarkets={markets} initialTrades={trades} />;
}
