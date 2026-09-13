import { DashboardClient } from "@/modules/DashboardPageModule/DashboardClient";
export default function DashboardPage() {
  return (
    <main className="mx-auto w-full max-w-[1300px] px-5 py-10 sm:px-8">
      <p className="text-xs font-bold tracking-[0.12em] text-brand-strong uppercase">
        Operations overview
      </p>
      <h1 className="mt-3 font-display text-4xl font-medium tracking-[-0.055em] sm:text-5xl">
        Human control, explicit handoffs.
      </h1>
      <p className="mt-4 max-w-2xl leading-7 text-muted-foreground">
        Prepare, approve, execute with MARKET_ADMIN, and reconcile every market creation and
        resolution.
      </p>
      <DashboardClient />
    </main>
  );
}
