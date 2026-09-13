import type { Metadata } from "next";
import { CreateMarketForm } from "@/modules/CreateMarketPageModule/CreateMarketForm";
export const metadata: Metadata = { title: "Create market" };
export default function CreateMarketPage() {
  return (
    <main className="mx-auto w-full max-w-[980px] px-5 py-10 sm:px-8">
      <p className="text-xs font-bold tracking-[0.12em] text-brand-strong uppercase">
        Manual market creation
      </p>
      <h1 className="mt-3 font-display text-4xl font-medium tracking-[-0.055em] sm:text-5xl">
        Prepare the evidence, then approve it.
      </h1>
      <p className="mt-4 max-w-2xl leading-7 text-muted-foreground">
        Select one Polymarket condition and up to 20 base tokens. Prepare a separate hash-bound
        packet for every pair, then review, approve and sign each market creation below.
      </p>
      <div className="mt-8">
        <CreateMarketForm />
      </div>
    </main>
  );
}
