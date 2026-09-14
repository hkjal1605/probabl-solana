"use client";
import { DataError } from "@/components/ui/page";
import { useMarkets } from "@/hooks/useProtocolData";
import type { MarketView } from "@/types/api";
import { FundsClient } from "./FundsClient";
export function FundsPageClient({ markets }: { markets: MarketView[] }) {
  const query = useMarkets(markets);
  return (
    <>
      {query.isError && (
        <DataError
          message="Indexed assets are unavailable."
          retry={() => {
            void query.refetch();
          }}
        />
      )}
      <FundsClient markets={query.markets} />
    </>
  );
}
