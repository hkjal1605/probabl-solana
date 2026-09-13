"use client";
import { Button } from "@conditional-stocks/ui-kit/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@conditional-stocks/ui-kit/sheet";
import { ArrowUpRight, Menu, Moon, Sun } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Logo } from "@/components/brand/Logo";
import { useUiStore } from "@/components/providers/UiStateProvider";
import { WalletButton } from "@/components/wallet/WalletButton";
import { cn } from "@/lib/utils";
import { FundsDialog } from "./FundsDialog";

export function SiteHeader() {
  const path = usePathname(),
    landing = path === "/";
  const setFunds = useUiStore((state) => state.setFunds);
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const navigation = landing
    ? [
        ["Markets", "/markets"],
        ["How it works", "/learn"],
      ]
    : [
        ["Markets", "/markets"],
        ["Portfolio", "/portfolio"],
        ["Resolution", "/resolution"],
      ];
  return (
    <>
      <header className="relative z-40 flex h-[62px] shrink-0 items-center gap-4 border-b px-[18px] sm:h-[68px] sm:gap-8 sm:px-8 min-[93.75rem]:px-[max(32px,calc((100vw_-_1376px)/2))]">
        <Logo />
        <nav
          aria-label="Main navigation"
          className={cn(
            "hidden items-center gap-6 text-sm font-medium text-muted-foreground md:flex",
            landing && "ml-auto",
          )}
        >
          {navigation.map(
            ([label, href]) =>
              href && (
                <Link
                  key={href}
                  href={href}
                  aria-current={path.startsWith(href) ? "page" : undefined}
                  className="transition-colors hover:text-positive aria-[current=page]:text-foreground"
                >
                  {label}
                </Link>
              ),
          )}
          {landing && (
            <>
              <span aria-disabled="true" title="Documentation coming soon">
                Docs
              </span>
              <a href="https://x.com/probabldottrade" target="_blank" rel="noopener noreferrer">
                X
              </a>
            </>
          )}
        </nav>
        <div className={cn("ml-auto flex items-center gap-2 sm:gap-3", landing && "md:ml-0")}>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!mounted}
            aria-label={
              mounted
                ? `Switch to ${resolvedTheme === "dark" ? "light" : "dark"} theme`
                : "Change color theme"
            }
            onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          >
            {mounted && resolvedTheme === "dark" ? <Sun /> : <Moon />}
          </Button>
          {landing ? (
            <Button asChild variant="outline">
              <Link href="/markets">
                Launch app <ArrowUpRight />
              </Link>
            </Button>
          ) : (
            <>
              <Button
                className="hidden sm:inline-flex"
                variant="outline"
                onClick={() => setFunds("Deposit")}
              >
                Funds
              </Button>
              <WalletButton />
            </>
          )}
          <Sheet>
            <SheetTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                className="md:hidden"
                aria-label="Open navigation"
              >
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>probabl</SheetTitle>
                <SheetDescription>Explore impact markets</SheetDescription>
              </SheetHeader>
              <nav className="mt-6 flex flex-col gap-2" aria-label="Mobile navigation">
                {[
                  ...navigation,
                  ["Orders", "/orders"],
                  ["Funds", "/funds"],
                  ["How it works", "/learn"],
                ]
                  .filter((item, i, all) => all.findIndex((other) => other[1] === item[1]) === i)
                  .map(
                    ([label, href]) =>
                      href && (
                        <SheetClose asChild key={href}>
                          <Button asChild variant="ghost" className="justify-start">
                            <Link href={href}>{label}</Link>
                          </Button>
                        </SheetClose>
                      ),
                  )}
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </header>
      <FundsDialog />
    </>
  );
}
