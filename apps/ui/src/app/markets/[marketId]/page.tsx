import type { Metadata } from "next";
import { MarketDetailPageModule } from "@/modules/MarketDetailPageModule";
export const metadata: Metadata = { title: "Market" };
export default async function MarketPage({ params }: { params: Promise<{ marketId: string }> }) {
  const { marketId } = await params;
  return <MarketDetailPageModule marketId={marketId} />;
}
