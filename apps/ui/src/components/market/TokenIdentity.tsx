import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import type { TokenDisplayMetadata } from "@/lib/tokens/devnet";

export function TokenIdentity({
  symbol,
  metadata,
  showName = true,
  iconSize = "default",
  textSize = "default",
}: {
  symbol: string;
  metadata?: TokenDisplayMetadata | undefined;
  showName?: boolean;
  iconSize?: "sm" | "default";
  textSize?: "default" | "lg";
}) {
  return (
    <InfoTooltip
      content={
        metadata
          ? `${metadata.name} (${metadata.symbol}) · ${metadata.devnet ? "Devnet test asset" : (metadata.issuer ?? "Issuer token")}`
          : symbol
      }
    >
      <span className="inline-flex min-w-0 max-w-full items-center gap-2 align-middle">
        {metadata && (
          <Avatar size={iconSize}>
            <AvatarImage src={metadata.image} alt="" />
            <AvatarFallback>{symbol.slice(0, 2)}</AvatarFallback>
          </Avatar>
        )}
        <span className="flex min-w-0 flex-col gap-1">
          <strong className={`block truncate font-medium ${textSize === "lg" ? "text-base" : ""}`}>
            {symbol}
          </strong>
          {metadata && showName && (
            <span
              className={`block truncate font-normal text-muted-foreground ${textSize === "lg" ? "text-sm" : "text-xs"}`}
            >
              {metadata.name}
            </span>
          )}
        </span>
      </span>
    </InfoTooltip>
  );
}
