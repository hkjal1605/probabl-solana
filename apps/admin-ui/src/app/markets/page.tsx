import type { Metadata } from "next";
import { MarketControls } from "@/modules/MarketControlsPageModule/MarketControls";
export const metadata: Metadata = { title: "Market controls" };
export default function MarketsPage() {
  return (
    <main className="mx-auto w-full max-w-[1080px] px-5 py-10 sm:px-8">
      <p className="text-xs font-bold tracking-[0.12em] text-brand-strong uppercase">
        Lifecycle and caps
      </p>
      <h1 className="mt-3 font-display text-4xl font-medium tracking-[-0.055em] sm:text-5xl">
        Canonical market controls.
      </h1>
      <p className="mt-4 max-w-2xl leading-7 text-muted-foreground">
        Review immutable caps, open scheduled markets and freeze trading with MARKET_ADMIN. Guardian
        emergency controls remain separately authorized onchain.
      </p>
      <MarketControls />
    </main>
  );
}
