import { Page, PageHeading } from "@/components/ui/page";
import { serverApi } from "@/lib/api/server";
import { FundsPageClient } from "./components/FundsPageClient";
export async function FundsPageModule() {
  const markets = await serverApi.markets();
  return (
    <Page>
      <PageHeading
        title="Funds"
        description="Your wallet stays in control. Manage whole tokens and spending permissions."
      />
      <FundsPageClient markets={markets} />
    </Page>
  );
}
