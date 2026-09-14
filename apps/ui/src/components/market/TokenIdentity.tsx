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
          <Avatar size="sm">
            <AvatarImage src={metadata.image} alt="" />
            <AvatarFallback>{symbol.slice(0, 2)}</AvatarFallback>
          </Avatar>
        )}
        <span className="min-w-0">
          <strong className="block truncate">{symbol}</strong>
          {metadata && showName && (
            <span className="block truncate text-[10px] font-normal leading-4 text-muted-foreground">
              {metadata.name}
            </span>
          )}
        </span>
      </span>
    </InfoTooltip>
  );
}
