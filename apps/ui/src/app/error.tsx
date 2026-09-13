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
    <main className="mx-auto flex min-h-[60svh] max-w-xl flex-col items-center justify-center px-5 text-center">
      <CircleAlert className="size-8 text-danger" />
      <h1 className="mt-5 text-2xl font-semibold">This view could not be loaded</h1>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        Retry when the services are available. If you recently submitted a transaction, check its
        status in your wallet before submitting again.
      </p>
      <Button className="mt-6" onClick={reset}>
        <RotateCcw />
        Try again
      </Button>
    </main>
  );
}
