import type { Metadata } from "next";
import { Page, PageHeading } from "@/components/ui/page";
import { ReviewQueue } from "@/modules/ReviewPageModule/ReviewQueue";
export const metadata: Metadata = { title: "Review queue" };
export default function ReviewPage() {
  return (
    <Page className="max-w-[1080px] py-8 sm:px-6">
      <PageHeading
        title="Review queue"
        description="Approve or reject append-only evidence, then preflight the exact transaction to execute."
      />
      <ReviewQueue />
    </Page>
  );
}
