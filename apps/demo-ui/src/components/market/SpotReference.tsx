import type { SpotPrice } from "@conditional-stocks/shared/spot-prices";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { Stat } from "@/components/ui/page";

export function formatSpotUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumSignificantDigits: 6,
  }).format(value);
}

export function SpotReference({
  price,
  variant = "default",
}: {
  price: SpotPrice | undefined;
  variant?: "default" | "market";
}) {
  const status = price?.status;
  const label =
    status === "available"
      ? null
      : status === "stale"
        ? "Stale"
        : status === "age-unverified"
          ? "Price age unverified"
          : "Price unavailable";
  return (
    <InfoTooltip
      content={
        price?.testAsset
          ? "Mainnet USD reference for a devnet test token. Not an executable quote or a settlement input."
          : "Token market reference in USD. Not an executable quote or a settlement input."
      }
    >
      <div className="flex flex-col gap-1">
        {variant === "market" ? (
          <Stat
            variant="market"
            label="Spot"
            value={price?.priceUsd ? formatSpotUsd(price.priceUsd) : "—"}
          />
        ) : (
          <>
            <div className="text-lg font-normal leading-5 tabular-nums">
              {price?.priceUsd ? formatSpotUsd(price.priceUsd) : "—"}
            </div>
            <div className="text-xs text-muted-foreground">Spot reference · USD</div>
          </>
        )}
        {variant !== "market" && label && (
          <div className="text-xs text-muted-foreground">
            {label}
            {price?.priceUsd && ["stale", "unavailable", "restricted"].includes(status ?? "")
              ? " · last known"
              : ""}
          </div>
        )}
      </div>
    </InfoTooltip>
  );
}
