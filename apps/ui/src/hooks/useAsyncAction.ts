"use client";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiError } from "@/lib/api/client";
import { createActionScope } from "@/lib/trading/action-scope";

/** Serializes wallet prompts and invalidates asynchronous work after identity/form changes or unmount. */
export function useAsyncAction(context: string) {
  const [scope] = useState(() => createActionScope(context));
  const mounted = useRef(true);
  scope.update(context);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    mounted.current = true;
    scope.mount();
    return () => {
      mounted.current = false;
      scope.dispose();
    };
  }, [scope]);
  const run = async (action: (assertCurrent: () => void) => Promise<void>) => {
    const operation = scope.begin();
    if (!operation) return;
    setBusy(true);
    try {
      await action(operation.assertCurrent);
    } catch (error) {
      // The API client invalidates only the token that received a 401. A late
      // response from an older session must not log out a newer sign-in.
      if (mounted.current)
        toast.error(
          error instanceof ApiError && error.status === 401
            ? "Your trading session expired. Review the action again to sign in."
            : error instanceof Error
              ? error.message
              : "Action failed.",
        );
    } finally {
      operation.finish();
      if (mounted.current) setBusy(false);
    }
  };
  return { busy, run };
}
