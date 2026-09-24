import { MarketWorkspace } from "./components/MarketWorkspace";
export function MarketDetailPageModule({ marketId }: { marketId: string }) {
  return (
    <MarketWorkspace key={marketId} marketId={marketId} initialMarkets={[]} initialTrades={[]} />
  );
}
