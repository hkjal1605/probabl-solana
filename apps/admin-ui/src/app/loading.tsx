import { Skeleton } from "@conditional-stocks/ui-kit/skeleton";
export default function Loading() {
  return (
    <main className="mx-auto w-full max-w-[1180px] px-5 py-10 sm:px-8">
      <Skeleton className="h-5 w-32" />
      <Skeleton className="mt-5 h-14 max-w-2xl" />
      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((item) => (
          <Skeleton key={item} className="h-44 rounded-2xl" />
        ))}
      </div>
    </main>
  );
}
