import { cn } from "../lib/utils.ts";

/** Original transparent SVG artwork, without a background in either theme. */
export function BrandLogo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex shrink-0 items-center px-2.5 py-2.5">
      <img
        src={compact ? "/brand/logo.svg" : "/brand/logo-name.svg"}
        alt="probabl"
        width={compact ? 1004 : 1878}
        height={compact ? 474 : 326}
        className={cn("block h-auto", compact ? "w-10" : "w-28 sm:w-36")}
        decoding="async"
      />
    </span>
  );
}
