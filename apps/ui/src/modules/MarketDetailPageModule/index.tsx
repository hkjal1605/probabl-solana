import { serverApi } from "@/lib/api/server";
import { MarketWorkspace } from "./components/MarketWorkspace";
export async function MarketDetailPageModule({ marketId }: { marketId: string }) {
  const [market, trades] = await Promise.all([serverApi.market(marketId), serverApi.trades(marketId)]);
  return <MarketWorkspace marketId={marketId} initialMarkets={market ? [market] : []} initialTrades={trades} />;
}
