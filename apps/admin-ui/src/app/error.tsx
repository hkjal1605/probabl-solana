"use client";
import { Button } from "@conditional-stocks/ui-kit/button";
import { CircleAlert, RotateCcw } from "lucide-react";
import { useEffect } from "react";
import { logger } from "@/lib/logger";
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    logger.error("ui.render.failed", { error, digest: error.digest });
  }, [error]);
  return (
    <main className="mx-auto flex min-h-[70svh] max-w-xl flex-col items-center justify-center px-5 text-center">
      <CircleAlert className="size-8 text-danger" />
      <h1 className="mt-5 text-2xl font-semibold">Operator view unavailable</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        No admin action was submitted. Retry after confirming the API and indexer state.
      </p>
      <Button className="mt-6" onClick={reset}>
        <RotateCcw />
        Try again
      </Button>
    </main>
  );
}
