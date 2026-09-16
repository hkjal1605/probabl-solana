import type { Metadata } from "next";
import { Page, PageHeading } from "@/components/ui/page";
import { HistoryClient } from "@/modules/HistoryPageModule/HistoryClient";
export const metadata: Metadata = { title: "Audit history" };
export default function HistoryPage() {
  return (
    <Page className="max-w-[1180px] py-8 sm:px-6">
      <PageHeading
        title="Audit history"
        description="An immutable record of preparation, approval, simulation, execution, and reconciliation."
      />
      <HistoryClient />
    </Page>
  );
}
