import type { Metadata } from "next";
import { Page, PageHeading } from "@/components/ui/page";
import { ResolutionForm } from "@/modules/ResolutionPageModule/ResolutionForm";
export const metadata: Metadata = { title: "Resolution" };
export default function ResolutionsPage() {
  return (
    <Page className="max-w-[980px] py-8 sm:px-6">
      <PageHeading
        title="Resolution"
        description="Build an evidence-backed payout from the final Polymarket snapshot and its immutable local mapping."
      />
      <ResolutionForm />
    </Page>
  );
}
