import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState, Page } from "@/components/ui/page";

export default function NotFound() {
  return (
    <Page>
      <EmptyState>
        <h1 className="text-2xl font-semibold text-foreground">Page not found</h1>
        <p>This page or market is not available.</p>
        <Button variant="default" render={<Link href="/" />} nativeButton={false}>
          Explore markets
        </Button>
      </EmptyState>
    </Page>
  );
}
