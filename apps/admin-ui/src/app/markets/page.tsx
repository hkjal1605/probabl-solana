import type { Metadata } from "next";
import { Page, PageHeading } from "@/components/ui/page";
import { MarketControls } from "@/modules/MarketControlsPageModule/MarketControls";
export const metadata: Metadata = { title: "Market controls" };
export default function MarketsPage() {
  return (
    <Page className="max-w-[1080px] py-8 sm:px-6">
      <PageHeading
        title="Market controls"
        description="Review immutable caps, open scheduled markets, and freeze trading with MARKET_ADMIN."
      />
      <MarketControls />
    </Page>
  );
}
