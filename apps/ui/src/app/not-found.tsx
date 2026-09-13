import { Button } from "@conditional-stocks/ui-kit/button";
import Link from "next/link";
import { EmptyState, Page } from "@/components/ui/page";

export default function NotFound() {
  return (
    <Page>
      <EmptyState>
        <h1 className="text-2xl font-semibold text-foreground">Page not found</h1>
        <p>This page or market is not available.</p>
        <Button asChild variant="brand">
          <Link href="/markets">Explore markets</Link>
        </Button>
      </EmptyState>
    </Page>
  );
}
