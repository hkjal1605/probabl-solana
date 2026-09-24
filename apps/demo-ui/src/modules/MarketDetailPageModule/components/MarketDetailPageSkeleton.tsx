import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Page } from "@/components/ui/page";
import { Skeleton } from "@/components/ui/skeleton";

const BOOK_ROWS = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;
const DETAIL_ROWS = [0, 1, 2] as const;
const CHART_BARS = [
  ["a", 42],
  ["b", 65],
  ["c", 51],
  ["d", 76],
  ["e", 58],
  ["f", 83],
  ["g", 69],
  ["h", 88],
  ["i", 74],
  ["j", 92],
  ["k", 80],
  ["l", 96],
] as const;

function StatSkeleton() {
  return (
    <div className="flex shrink-0 flex-col gap-1">
      <Skeleton className="h-3 w-16" />
      <Skeleton className="h-5 w-24" />
    </div>
  );
}

export function MarketDetailPageSkeleton() {
  return (
    <Page
      variant="terminal"
      className="market-workspace-scrollbars-hidden flex min-h-0 flex-col bg-secondary px-0 py-0 xl:overflow-hidden"
    >
      <div role="status" aria-label="Loading market" aria-busy="true" className="contents">
        <div className="flex flex-wrap items-start justify-between gap-3 bg-background px-3 py-3">
          <div className="flex min-w-0 flex-[1_1_28rem] items-center gap-3">
            <Skeleton className="size-10 shrink-0 rounded-xl" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Skeleton className="h-5 w-full max-w-xl" />
              <div className="flex gap-3">
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-3 w-12" />
                <Skeleton className="h-3 w-10" />
              </div>
            </div>
            <Skeleton className="h-10 w-14 shrink-0 rounded-xl" />
          </div>
          <div className="flex gap-1 rounded-lg bg-secondary p-1">
            {DETAIL_ROWS.map((asset) => (
              <Skeleton key={asset} className="h-8 w-16 rounded-md" />
            ))}
          </div>
        </div>

        <div className="market-workspace-grid grid min-h-0 flex-1 items-stretch gap-0.5 bg-secondary p-0.5 xl:overflow-hidden">
          <div className="market-workspace-stats overflow-hidden rounded-[4px] bg-background">
            <div className="flex flex-wrap items-start gap-x-6 gap-y-3 border-y px-3 py-3">
              <StatSkeleton />
              <StatSkeleton />
              <StatSkeleton />
            </div>
          </div>

          <div className="market-workspace-chart flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[4px] bg-background p-3">
            <div className="flex items-center justify-between gap-4">
              <Skeleton className="h-8 w-64 max-w-[55%] rounded-lg" />
              <Skeleton className="h-8 w-44 max-w-[40%] rounded-lg" />
            </div>
            <div className="mt-4 flex min-h-44 flex-1 items-end gap-5 border-b border-l border-border/50 px-4 pb-4">
              {CHART_BARS.map(([id, height]) => (
                <Skeleton
                  key={id}
                  className="min-w-1 flex-1 rounded-sm"
                  style={{ height: `${height}%` }}
                />
              ))}
            </div>
          </div>

          <Card
            variant="panel"
            className="market-workspace-book min-h-0 min-w-0 data-[variant=panel]:rounded-[4px]"
          >
            <CardHeader className="flex flex-wrap items-center justify-between gap-3">
              <Skeleton className="h-8 w-48 rounded-lg" />
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col justify-center overflow-hidden px-0">
              <div className="grid grid-cols-3 gap-5 px-3 py-2">
                <Skeleton className="h-3 w-10" />
                <Skeleton className="ml-auto h-3 w-20" />
                <Skeleton className="ml-auto h-3 w-20" />
              </div>
              {BOOK_ROWS.map((row) => (
                <div key={row} className="grid grid-cols-3 gap-5 px-3 py-1.5">
                  <Skeleton className="h-4 w-14" />
                  <Skeleton className="ml-auto h-4 w-16" />
                  <Skeleton className="ml-auto h-4 w-16" />
                </div>
              ))}
            </CardContent>
          </Card>

          <div className="market-workspace-ticket min-h-0 min-w-0 overflow-hidden rounded-[4px] bg-card">
            <div className="grid grid-cols-2 border-b border-border">
              <Skeleton className="m-3 h-7 rounded-md" />
              <Skeleton className="m-3 h-7 rounded-md" />
            </div>
            <div className="flex flex-col gap-4 p-3">
              <Skeleton className="h-12 w-full rounded-lg" />
              <div className="flex flex-col gap-2">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-14 w-full rounded-lg" />
              </div>
              <div className="flex flex-col gap-2">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-14 w-full rounded-lg" />
              </div>
              <Skeleton className="h-10 w-full rounded-lg" />
              <div className="flex flex-col gap-3 pt-1">
                {DETAIL_ROWS.map((row) => (
                  <div key={row} className="flex items-center justify-between gap-4">
                    <Skeleton className="h-3 w-24" />
                    <Skeleton className="h-3 w-16" />
                  </div>
                ))}
              </div>
            </div>
          </div>

          <Card
            variant="panel"
            className="market-workspace-information min-h-0 min-w-0 overflow-hidden data-[variant=panel]:rounded-[4px]"
          >
            <div className="flex gap-6 px-3 py-2">
              {DETAIL_ROWS.map((tab) => (
                <Skeleton key={tab} className="h-4 w-20" />
              ))}
              <Skeleton className="h-4 w-12" />
            </div>
            <div className="grid grid-cols-4 gap-6 px-3 py-4">
              {BOOK_ROWS.slice(0, 8).map((cell) => (
                <Skeleton key={cell} className="h-4 w-full" />
              ))}
            </div>
          </Card>
        </div>
      </div>
    </Page>
  );
}
