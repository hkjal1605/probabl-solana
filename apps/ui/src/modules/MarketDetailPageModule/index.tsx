import { MarketWorkspace } from "./components/MarketWorkspace";
export function MarketDetailPageModule({ marketId }: { marketId: string }) {
  return <MarketWorkspace marketId={marketId} initialMarkets={[]} initialTrades={[]} />;
}
