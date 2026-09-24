"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ClipboardCopy,
  FileSearch,
  LoaderCircle,
  PenLine,
  RotateCcw,
} from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { useAdmin } from "@/components/providers/AdminProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { adminConfig } from "@/config/protocol";
import type { SetupStep } from "@/lib/market-setup";
import { preflightTransaction, waitForAdminReceipt } from "@/lib/transactions";

type Status = "pending" | "simulated" | "confirmed" | "failed";

/** Ordered, explicit review → simulate → sign UX for dependent admin transactions.
 * Each step is preflighted again by the wallet flow before signing. */
export function TransactionSequence({
  load,
  reviewLabel,
  emptyMessage = "Nothing left to sign.",
  onComplete,
}: {
  load: () => Promise<SetupStep[]>;
  reviewLabel: string;
  emptyMessage?: string;
  onComplete?: () => void;
}) {
  const admin = useAdmin(),
    cache = useQueryClient();
  const [steps, setSteps] = useState<SetupStep[] | null>(null);
  const [status, setStatus] = useState<Status[]>([]);
  const [signatures, setSignatures] = useState<(string | null)[]>([]);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const next = status.findIndex((value) => value !== "confirmed");
  const authority = steps?.[next]?.transaction.from;
  const run = async (action: (check: () => void) => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await action(admin.captureContext());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Transaction step failed");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const review = () =>
    run(async (check) => {
      setSteps(null);
      const loaded = await load();
      check();
      setSteps(loaded);
      setStatus(loaded.map(() => "pending"));
      setSignatures(loaded.map(() => null));
      if (!loaded.length) onComplete?.();
    });
  const mark = (index: number, value: Status) =>
    setStatus((current) => current.map((item, i) => (i === index ? value : item)));
  const simulate = () =>
    run(async () => {
      if (!steps || next < 0) return;
      try {
        await preflightTransaction(steps[next]!.transaction);
        mark(next, "simulated");
        toast.success(`Step ${next + 1} passed the live simulation`);
      } catch (error) {
        mark(next, "failed");
        throw error;
      }
    });
  const signRemaining = () =>
    run(async (check) => {
      if (!steps) return;
      for (let index = next; index >= 0 && index < steps.length; index++) {
        check();
        try {
          const signature = await admin.sendTransaction(steps[index]!.transaction);
          setSignatures((current) => current.map((item, i) => (i === index ? signature : item)));
          await waitForAdminReceipt(signature);
          mark(index, "confirmed");
        } catch (error) {
          mark(index, "failed");
          throw error;
        }
      }
      await cache.invalidateQueries({ queryKey: ["markets"] });
      await cache.invalidateQueries({ queryKey: ["market-chain"] });
      toast.success("All steps confirmed. Indexed state may lag.");
      onComplete?.();
    });
  const allDone = steps !== null && next === -1;
  return (
    <div className="flex flex-col gap-3">
      {steps === null ? (
        <Button variant="outline" disabled={busy || admin.signing} onClick={review}>
          {busy ? <LoaderCircle className="animate-spin" /> : <FileSearch />}
          {reviewLabel}
        </Button>
      ) : steps.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          {emptyMessage}
        </p>
      ) : (
        <>
          <ol className="flex flex-col gap-2">
            {steps.map((step, index) => (
              <li
                key={step.transaction.data}
                className="rounded-lg bg-secondary p-3 text-xs leading-6"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold">
                    Step {index + 1} of {steps.length} · {step.title}
                  </p>
                  <Badge
                    variant={
                      status[index] === "confirmed"
                        ? "positive"
                        : status[index] === "failed"
                          ? "destructive"
                          : status[index] === "simulated"
                            ? "warning"
                            : "secondary"
                    }
                  >
                    {status[index]}
                  </Badge>
                </div>
                <ul className="mt-1 list-disc pl-5">
                  {step.details.map((detail) => (
                    <li key={detail} className="break-all">
                      {detail}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 break-all font-mono text-muted-foreground">
                  Signer: {step.transaction.from}
                </p>
                {signatures[index] && (
                  <p className="break-all font-mono">Signature: {signatures[index]}</p>
                )}
                <Button
                  className="mt-2"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    navigator.clipboard
                      .writeText(
                        JSON.stringify(
                          { to: step.transaction.to, data: step.transaction.data, value: "0" },
                          null,
                          2,
                        ),
                      )
                      .then(() => toast.success("Solana instruction payload copied"))
                      .catch(() => toast.error("Clipboard unavailable"))
                  }
                >
                  <ClipboardCopy />
                  Copy instructions
                </Button>
              </li>
            ))}
          </ol>
          {allDone ? (
            <p role="status" className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="size-4 text-positive" /> Every step is confirmed.
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Real onchain transactions on {adminConfig.chainName}; each costs SOL. Steps depend
                on each other, so only the next step can be simulated. Each is simulated again
                before the wallet request.
                {authority && admin.account !== authority
                  ? " Connect the signer wallet shown above to continue."
                  : ""}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={busy || admin.signing} onClick={simulate}>
                  <FileSearch />
                  Simulate step {next + 1}
                </Button>
                <Button
                  disabled={busy || admin.signing || admin.account !== authority}
                  onClick={signRemaining}
                >
                  {busy ? <LoaderCircle className="animate-spin" /> : <PenLine />}
                  Sign{" "}
                  {steps.length - next === 1
                    ? `step ${next + 1}`
                    : `steps ${next + 1}–${steps.length} in order`}
                </Button>
                {status.includes("failed") && (
                  <Button variant="ghost" disabled={busy || admin.signing} onClick={review}>
                    <RotateCcw />
                    Reload remaining steps from chain
                  </Button>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
