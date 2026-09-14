"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Separator } from "@/components/ui/separator";
export function SiteFooter() {
  const path = usePathname();
  if (path === "/") return null;
  return (
    <footer className="mt-auto">
      <Separator />
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs text-muted-foreground">
        <span>probabl · Impact markets</span>
        <nav aria-label="Footer" className="flex gap-4">
          <Link href="/orders">Orders</Link>
          <Link href="/learn">Risks & mechanics</Link>
          <Link href="/funds">Funds</Link>
        </nav>
      </div>
    </footer>
  );
}
