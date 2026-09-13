import type { Metadata } from "next";
import { HistoryClient } from "@/modules/HistoryPageModule/HistoryClient";
export const metadata: Metadata = { title: "Audit history" };
export default function HistoryPage() {
  return (
    <main className="mx-auto w-full max-w-[1180px] px-5 py-10 sm:px-8">
      <p className="text-xs font-bold tracking-[0.12em] text-brand-strong uppercase">
        Append-only audit trail
      </p>
      <h1 className="mt-3 font-display text-4xl font-medium tracking-[-0.055em] sm:text-5xl">
        Every operator handoff.
      </h1>
      <p className="mt-4 max-w-2xl leading-7 text-muted-foreground">
        Packet preparation, market-admin approval, simulation, verification, and canonical
        reconciliation remain attributable and immutable.
      </p>
      <HistoryClient />
    </main>
  );
}
