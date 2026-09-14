import { Skeleton } from "@/components/ui/skeleton";
export default function Loading() {
  return (
    <main
      aria-label="Loading page"
      aria-busy="true"
      className="mx-auto flex w-full flex-1 flex-col gap-3 px-3 py-3"
    >
      <Skeleton className="h-5 w-28" />
      <Skeleton className="h-9 w-full max-w-xl" />
      <div className="flex flex-col gap-1">
        {[0, 1, 2].map((item) => (
          <Skeleton key={item} className="h-14 w-full rounded-sm" />
        ))}
      </div>
    </main>
  );
}
