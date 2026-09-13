"use client";
import { Button } from "@conditional-stocks/ui-kit/button";

export function QueryStatus({
  query,
}: {
  query: {
    isPending: boolean;
    isError: boolean;
    error: Error | null;
    refetch: () => Promise<unknown>;
  };
}) {
  if (query.isError)
    return (
      <div role="alert" className="my-4 rounded-xl border border-destructive/40 p-4 text-sm">
        <p>
          {query.error?.message ?? "Live data is unavailable."} Any previously loaded data may be
          stale.
        </p>
        <Button
          className="mt-2"
          size="sm"
          variant="outline"
          onClick={() => {
            void query.refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );
  if (query.isPending)
    return (
      <p role="status" className="my-4 text-sm text-muted-foreground">
        Reading live data…
      </p>
    );
  return null;
}
