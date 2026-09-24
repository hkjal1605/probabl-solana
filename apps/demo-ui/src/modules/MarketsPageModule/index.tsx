import type { MarketCategory } from "@/lib/markets/presentation";
import { MarketsExplorer } from "./components/MarketsExplorer";

export function MarketsPageModule({ category = "All" }: { category?: MarketCategory }) {
  return <MarketsExplorer markets={[]} category={category} />;
}
