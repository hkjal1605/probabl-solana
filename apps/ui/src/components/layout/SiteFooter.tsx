"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
export function SiteFooter() {
  const path = usePathname();
  if (path === "/") return null;
  return (
    <footer className="mt-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-4 text-xs font-medium text-muted-foreground sm:px-8 min-[93.75rem]:px-[max(32px,calc((100vw_-_1376px)/2))]">
        <span>probabl · Impact markets</span>
        <nav aria-label="Footer" className="flex gap-6">
          <Link href="/orders">Orders</Link>
          <Link href="/learn">Risks & mechanics</Link>
          <Link href="/funds">Funds</Link>
        </nav>
      </div>
    </footer>
  );
}
