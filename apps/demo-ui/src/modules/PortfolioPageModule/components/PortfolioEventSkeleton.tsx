import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function PortfolioEventSkeleton() {
  return (
    <Card
      className="gap-0 rounded-xl bg-card pt-0 pb-2 ring-0"
      role="status"
      aria-label="Loading portfolio positions"
    >
      <CardHeader className="flex flex-row items-start justify-between gap-5 border-0 px-5 py-6">
        <Skeleton className="h-6 w-3/5 max-w-96" />
        <Skeleton className="h-8 w-20 shrink-0" />
      </CardHeader>
      <CardContent className="px-0 pb-0" aria-hidden="true">
        <div className="flex gap-6 px-4 pb-4">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-5 w-16" />
        </div>
        <div className="flex flex-col gap-5 px-5 py-5">
          <div className="flex items-center justify-between gap-4">
            <Skeleton className="h-5 w-1/3" />
            <Skeleton className="h-5 w-16" />
          </div>
          <div className="flex items-center justify-between gap-4">
            <Skeleton className="h-5 w-2/5" />
            <Skeleton className="h-5 w-20" />
          </div>
          <div className="flex items-center justify-between gap-4">
            <Skeleton className="h-5 w-1/4" />
            <Skeleton className="h-5 w-16" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
