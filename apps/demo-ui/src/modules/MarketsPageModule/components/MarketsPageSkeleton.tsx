import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const CARD_ROWS = [0, 1, 2] as const;
const FEED_CARDS = [0, 1, 2, 3, 4, 5] as const;
const MATRIX_ROWS = [0, 1, 2, 3, 4, 5] as const;

function FeaturedBannerSkeleton() {
  return (
    <Card className="mb-6 overflow-hidden rounded-xl bg-overlay py-0 ring-0" aria-hidden="true">
      <CardContent className="grid gap-8 px-6 py-7 sm:px-8 sm:py-9 lg:grid-cols-[minmax(0,1fr)_minmax(420px,0.9fr)] lg:items-center lg:gap-12">
        <div className="flex min-w-0 flex-col items-start">
          <Skeleton className="h-3 w-36" />
          <Skeleton className="mt-4 h-10 w-full max-w-xl" />
          <div className="mt-3 flex w-full max-w-lg gap-5">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-5 w-24" />
          </div>
          <div className="mt-7 flex items-center gap-4">
            <Skeleton className="h-10 w-40 rounded-lg" />
            <Skeleton className="h-5 w-20" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function EventCardSkeleton() {
  return (
    <Card variant="market" className="min-w-0" aria-hidden="true">
      <CardHeader className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3">
        <Skeleton className="size-12 rounded-xl" />
        <div className="flex min-w-0 flex-col gap-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
        <Skeleton className="h-12 w-16 rounded-xl" />
      </CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableHeader className="[&_tr]:border-0">
            <TableRow className="border-0 bg-accent hover:bg-accent">
              {CARD_ROWS.map((column) => (
                <TableHead key={column} className="px-2">
                  <Skeleton className="h-3 w-10" />
                </TableHead>
              ))}
              <TableHead className="px-2">
                <Skeleton className="ml-auto h-3 w-10" />
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {CARD_ROWS.map((row) => (
              <TableRow key={row} className="border-0 hover:bg-transparent">
                <TableCell className="w-px px-2">
                  <div className="flex items-center gap-2">
                    <Skeleton className="size-6 rounded-full" />
                    <Skeleton className="h-4 w-10" />
                  </div>
                </TableCell>
                <TableCell className="w-1/3 px-2">
                  <Skeleton className="h-7 w-full" />
                </TableCell>
                <TableCell className="w-px px-2">
                  <Skeleton className="mx-auto h-4 w-12" />
                </TableCell>
                <TableCell className="w-1/3 px-2">
                  <Skeleton className="ml-auto h-7 w-full" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function MatrixSkeleton() {
  return (
    <Card variant="panel" aria-hidden="true">
      <Table>
        <TableHeader className="[&_tr]:border-b-0">
          <TableRow className="border-b-0 hover:bg-transparent [&_th]:py-3">
            <TableHead>
              <Skeleton className="h-4 w-16" />
            </TableHead>
            {CARD_ROWS.map((column) => (
              <TableHead key={column}>
                <Skeleton className="h-6 w-16" />
              </TableHead>
            ))}
            <TableHead>
              <Skeleton className="mx-auto h-4 w-20" />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {MATRIX_ROWS.map((row) => (
            <TableRow key={row} className="border-b-0 hover:bg-transparent">
              <TableCell>
                <Skeleton className="h-5 w-full max-w-72" />
              </TableCell>
              {CARD_ROWS.map((column) => (
                <TableCell key={column}>
                  <Skeleton className="h-12 min-w-24" />
                </TableCell>
              ))}
              <TableCell>
                <Skeleton className="mx-auto h-12 w-16 rounded-xl" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

export function MarketsPageSkeleton({ view }: { view: "Feed" | "Matrix" }) {
  return (
    <div role="status" aria-label="Loading markets" aria-busy="true">
      <FeaturedBannerSkeleton />
      {view === "Feed" ? (
        <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {FEED_CARDS.map((card) => (
            <EventCardSkeleton key={card} />
          ))}
        </div>
      ) : (
        <MatrixSkeleton />
      )}
    </div>
  );
}
