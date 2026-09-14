import { Page, PageHeading } from "@/components/ui/page";
import { OrdersPageClient } from "./components/OrdersPageClient";
export function OrdersPageModule() {
  const markets: import("@/types/api").MarketView[] = [];
  return (
    <Page>
      <PageHeading
        title="Orders"
        description="Open orders, fills, and released funds. Updates appear after canonical chain confirmation."
      />
      <OrdersPageClient markets={markets} />
    </Page>
  );
}
