import { Page, PageHeading } from "@/components/ui/page";
import { FundsPageClient } from "./components/FundsPageClient";
export function FundsPageModule() {
  const markets: import("@/types/api").MarketView[] = [];
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
