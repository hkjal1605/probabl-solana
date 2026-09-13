import { serverApi } from "@/lib/api/server";
import { PortfolioClient } from "./components/PortfolioClient";
export async function PortfolioPageModule() {
  const markets = await serverApi.markets();
  return <PortfolioClient markets={markets} />;
}
