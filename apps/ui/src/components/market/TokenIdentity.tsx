import Image from "next/image";
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
    <span
      className="inline-flex min-w-0 max-w-full items-center gap-2 align-middle"
      title={metadata ? `${metadata.name} (${metadata.symbol}) · Devnet test asset` : symbol}
    >
      {metadata && (
        <Image
          src={metadata.image}
          alt=""
          width={24}
          height={24}
          unoptimized
          className="size-6 shrink-0 rounded-full"
        />
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
  );
}
