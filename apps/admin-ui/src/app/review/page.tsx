import type { Metadata } from "next";
import { ReviewQueue } from "@/modules/ReviewPageModule/ReviewQueue";
export const metadata: Metadata = { title: "Review queue" };
export default function ReviewPage() {
  return (
    <main className="mx-auto w-full max-w-[1080px] px-5 py-10 sm:px-8">
      <p className="text-xs font-bold tracking-[0.12em] text-brand-strong uppercase">
        Explicit evidence approval
      </p>
      <h1 className="mt-3 font-display text-4xl font-medium tracking-[-0.055em] sm:text-5xl">
        Review before execution.
      </h1>
      <p className="mt-4 max-w-2xl leading-7 text-muted-foreground">
        Approve or reject append-only packets, then preflight the exact transaction the authorized
        wallet or multisig should execute.
      </p>
      <ReviewQueue />
    </main>
  );
}
