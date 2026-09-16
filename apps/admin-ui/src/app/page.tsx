import { Page, PageHeading } from "@/components/ui/page";
import { DashboardClient } from "@/modules/DashboardPageModule/DashboardClient";
export default function DashboardPage() {
  return (
    <Page className="max-w-[1200px] py-8 sm:px-6">
      <PageHeading
        title="Operations overview"
        description="Prepare, approve, execute, and reconcile every market operation."
      />
      <DashboardClient />
    </Page>
  );
}
