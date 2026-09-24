import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { MarketView } from "@/types/api";
export function MarketRules({ market }: { market: MarketView }) {
  return (
    <div className="flex flex-col gap-4 p-5">
      <h3 className="font-semibold">Exact market terms</h3>
      <p className="text-sm leading-6 text-muted-foreground">{market.description}</p>
      <dl className="grid gap-4 sm:grid-cols-2">
        {[
          ["Polymarket evidence condition", market.mapping.conditionId],
          ["Market", market.id],
          ["YES / NO index", `${market.mapping.yesIndex} / ${market.mapping.noIndex}`],
          ["Cutoff", market.cutoff],
          ["Stock token", market.baseToken],
          ["Quote token", market.quoteToken],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
            <dd className="mt-1 break-all font-mono text-xs">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs leading-5 text-muted-foreground">
        Polymarket is informational. Evidence is independently reviewed before the protocol admin
        executes a resolution transaction. Claims settle against the canonical onchain payout.
      </p>
      <Button
        variant="outline"
        render={<Link href={`/resolution?market=${market.id}`} />}
        nativeButton={false}
      >
        Open resolution center →
      </Button>
    </div>
  );
}
