import type { Metadata } from "next";
import { Page, PageHeading } from "@/components/ui/page";
import { SystemHealth } from "@/modules/SystemPageModule/SystemHealth";
export const metadata: Metadata = { title: "System health" };
export default function SystemPage() {
  return (
    <Page className="max-w-[1180px] py-8 sm:px-6">
      <PageHeading
        title="System health"
        description="Monitor service health and prepare explicitly authorized incident actions."
      />
      <SystemHealth />
    </Page>
  );
}
