import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import type { TokenDisplayMetadata } from "@/lib/tokens/devnet";

export function TokenIdentity({
  symbol,
  metadata,
  showName = true,
}: {
  symbol: string;
  metadata?: TokenDisplayMetadata | undefined;
  showName?: boolean;
}) {
  return (
    <InfoTooltip
      content={metadata ? `${metadata.name} (${metadata.symbol}) · Devnet test asset` : symbol}
    >
      <span className="inline-flex min-w-0 max-w-full items-center gap-2 align-middle">
        {metadata && (
          <Avatar>
            <AvatarImage src={metadata.image} alt="" />
            <AvatarFallback>{symbol.slice(0, 2)}</AvatarFallback>
          </Avatar>
        )}
        <span className="flex min-w-0 flex-col gap-1">
          <strong className="block truncate font-medium">{symbol}</strong>
          {metadata && showName && (
            <span className="block truncate text-xs font-normal text-muted-foreground">
              {metadata.name}
            </span>
          )}
        </span>
      </span>
    </InfoTooltip>
  );
}
