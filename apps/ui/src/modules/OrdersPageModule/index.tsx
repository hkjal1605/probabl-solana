import { Page, PageHeading } from "@/components/ui/page";
import { serverApi } from "@/lib/api/server";
import { OrdersPageClient } from "./components/OrdersPageClient";
export async function OrdersPageModule() {
  const markets = await serverApi.markets();
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
