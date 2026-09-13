import type { SpotPrice } from "@conditional-stocks/shared/spot-prices";

export function formatSpotUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumSignificantDigits: 6,
  }).format(value);
}

export function SpotReference({ price }: { price: SpotPrice | undefined }) {
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
    <div
      title={
        price?.testAsset
          ? "Mainnet USD reference for a devnet test token. Not an executable quote or a settlement input."
          : "Token market reference in USD. Not an executable quote or a settlement input."
      }
    >
      <div className="font-mono text-xl font-medium leading-tight">
        {price?.priceUsd ? formatSpotUsd(price.priceUsd) : "—"}
      </div>
      <div className="mt-2 text-xs font-medium text-muted-foreground">Spot reference · USD</div>
      {label && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {label}
          {price?.priceUsd && ["stale", "unavailable", "restricted"].includes(status ?? "")
            ? " · last known"
            : ""}
        </p>
      )}
    </div>
  );
}
