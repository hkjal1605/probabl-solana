import { Skeleton } from "@conditional-stocks/ui-kit/skeleton";
export default function Loading() {
  return (
    <main
      aria-label="Loading page"
      aria-busy="true"
      className="mx-auto w-full max-w-[1440px] flex-1 px-5 py-8 sm:px-8 lg:py-10"
    >
      <Skeleton className="h-5 w-28" />
      <Skeleton className="mt-6 h-10 max-w-3xl" />
      <div className="mt-10 grid gap-4 lg:grid-cols-3">
        {[0, 1, 2].map((item) => (
          <Skeleton key={item} className="h-64 rounded-lg" />
        ))}
      </div>
    </main>
  );
}
