import type { Metadata } from "next";
import { Page, PageHeading } from "@/components/ui/page";
import { CreateMarketForm } from "@/modules/CreateMarketPageModule/CreateMarketForm";
export const metadata: Metadata = { title: "Create market" };
export default function CreateMarketPage() {
  return (
    <Page className="max-w-[980px] py-8 sm:px-6">
      <PageHeading
        title="Create market"
        description="Select one Polymarket condition and prepare a separate hash-bound packet for every token pair."
      />
      <CreateMarketForm />
    </Page>
  );
}
