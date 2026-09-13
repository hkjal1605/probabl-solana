import type { Metadata } from "next";
import { SystemHealth } from "@/modules/SystemPageModule/SystemHealth";
export const metadata: Metadata = { title: "System health" };
export default function SystemPage() {
  return (
    <main className="mx-auto w-full max-w-[1180px] px-5 py-10 sm:px-8">
      <p className="text-xs font-bold tracking-[0.12em] text-brand-strong uppercase">
        System and incidents
      </p>
      <h1 className="mt-3 font-display text-4xl font-medium tracking-[-0.055em] sm:text-5xl">
        Observe first. Act explicitly.
      </h1>
      <p className="mt-4 max-w-2xl leading-7 text-muted-foreground">
        Service health is operational context. Wallet-authorized program actions and canonical
        reconciliation remain the source of truth.
      </p>
      <SystemHealth />
    </main>
  );
}
