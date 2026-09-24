import { PortfolioClient } from "./components/PortfolioClient";
export function PortfolioPageModule() {
  const markets: import("@/types/api").MarketView[] = [];
  return <PortfolioClient markets={markets} />;
}
