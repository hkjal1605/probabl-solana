"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/** Pending consent is cancelled when its wallet/action scope changes or unmounts. */
export function useConfirmation(scope: string) {
  const [message, setMessage] = useState<string | null>(null);
  const pending = useRef<((accepted: boolean) => void) | null>(null);
  const finish = useCallback((accepted: boolean) => {
    const resolve = pending.current;
    pending.current = null;
    setMessage(null);
    resolve?.(accepted);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A scope change must cancel pending consent even when no values are captured.
  useEffect(() => {
    setMessage(null);
    return () => {
      pending.current?.(false);
      pending.current = null;
    };
  }, [scope]);
  const confirm = useCallback((description: string) => {
    pending.current?.(false);
    setMessage(description);
    return new Promise<boolean>((resolve) => {
      pending.current = resolve;
    });
  }, []);
  const confirmation = (
    <AlertDialog
      open={message !== null}
      onOpenChange={(open) => {
        if (!open) finish(false);
      }}
    >
      <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>Review issuer transfer fees</AlertDialogTitle>
          <AlertDialogDescription className="whitespace-pre-line break-words">
            {message}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => finish(false)}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => finish(true)}>
            Accept fees and continue
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return { confirm, confirmation };
}
