import type { Metadata } from "next";
import { ResolutionForm } from "@/modules/ResolutionPageModule/ResolutionForm";
export const metadata: Metadata = { title: "Resolution" };
export default function ResolutionsPage() {
  return (
    <main className="mx-auto w-full max-w-[980px] px-5 py-10 sm:px-8">
      <p className="text-xs font-bold tracking-[0.12em] text-brand-strong uppercase">
        Manual resolution
      </p>
      <h1 className="mt-3 font-display text-4xl font-medium tracking-[-0.055em] sm:text-5xl">
        Build an evidence-backed payout.
      </h1>
      <p className="mt-4 max-w-2xl leading-7 text-muted-foreground">
        Attach a final Polymarket snapshot and Polygon reference to the immutable local market
        mapping. There is no automated cross-chain message in v1.
      </p>
      <div className="mt-8">
        <ResolutionForm />
      </div>
    </main>
  );
}
