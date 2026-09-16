"use client";
import { CircleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

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
      <Alert variant="destructive" className="my-4">
        <CircleAlert />
        <AlertTitle>Live data unavailable</AlertTitle>
        <AlertDescription>
          <p>
            {query.error?.message ?? "Live data is unavailable."} Any previously loaded data may be
            stale.
          </p>
          <Button
            className="mt-3"
            size="sm"
            variant="outline"
            onClick={() => {
              void query.refetch();
            }}
          >
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  if (query.isPending)
    return (
      <div role="status" aria-label="Loading live data" className="my-6 flex justify-center">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );
  return null;
}
