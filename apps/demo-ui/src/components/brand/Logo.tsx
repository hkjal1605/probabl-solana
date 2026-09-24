import Image from "next/image";
import Link from "next/link";

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <Link className="inline-flex w-fit shrink-0 rounded-lg" href="/" aria-label="probabl home">
      {/* Exact shared transparent wordmark; an SVG does not need image optimization. */}
      <Image
        src={compact ? "/brand/logo.svg" : "/brand/logo-name.svg"}
        alt="probabl"
        unoptimized
        width={144}
        height={25}
        className={compact ? "size-8" : "h-auto w-28 sm:w-36"}
      />
    </Link>
  );
}
