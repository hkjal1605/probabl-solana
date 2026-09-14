import { ResolutionClient } from "./components/ResolutionClient";
export function ResolutionPageModule({ selected }: { selected?: string }) {
  const markets: import("@/types/api").MarketView[] = [];
  return <ResolutionClient markets={markets} selected={selected} />;
}
