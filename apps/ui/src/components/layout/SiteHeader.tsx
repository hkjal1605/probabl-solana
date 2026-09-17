"use client";
import { ArrowUpRight, Menu, Moon, Sun } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Logo } from "@/components/brand/Logo";
import { Button } from "@/components/ui/button";
import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
} from "@/components/ui/navigation-menu";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { WalletButton } from "@/components/wallet/WalletButton";
import { cn } from "@/lib/utils";
import { MarketSearch } from "@/modules/MarketSearchModule";

export function SiteHeader() {
  const path = usePathname(),
    landing = path === "/";
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
      ];
  return (
    <header className="relative z-40 flex h-14 shrink-0 items-center gap-4 border-b bg-background px-3 sm:h-12 sm:gap-6">
      <Logo />
      <NavigationMenu
        aria-label="Main navigation"
        className={cn("hidden items-center", landing ? "xl:flex" : "md:flex")}
      >
        <NavigationMenuList>
          {navigation.map(
            ([label, href]) =>
              href && (
                <NavigationMenuItem key={href}>
                  <NavigationMenuLink active={path.startsWith(href)} render={<Link href={href} />}>
                    <span
                      className={cn(
                        (label === "Markets" || label === "Portfolio") && "text-base font-medium",
                      )}
                    >
                      {label}
                    </span>
                  </NavigationMenuLink>
                </NavigationMenuItem>
              ),
          )}
        </NavigationMenuList>
      </NavigationMenu>
      <div className="absolute left-1/2 -translate-x-1/2">
        <MarketSearch />
      </div>
      <div className="ml-auto flex items-center gap-2">
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
          <Button variant="outline" render={<Link href="/markets" />} nativeButton={false}>
            Launch app <ArrowUpRight />
          </Button>
        ) : (
          <WalletButton />
        )}
        <Sheet>
          <SheetTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                className={landing ? "xl:hidden" : "md:hidden"}
                aria-label="Open navigation"
              />
            }
          >
            <Menu />
          </SheetTrigger>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>probabl</SheetTitle>
              <SheetDescription>Explore impact markets</SheetDescription>
            </SheetHeader>
            <nav className="mt-6 flex flex-col gap-2" aria-label="Mobile navigation">
              {[...navigation, ["Orders", "/orders"], ["How it works", "/learn"]]
                .filter((item, i, all) => all.findIndex((other) => other[1] === item[1]) === i)
                .map(
                  ([label, href]) =>
                    href && (
                      <SheetClose
                        key={href}
                        nativeButton={false}
                        render={
                          <Button
                            variant="ghost"
                            className="justify-start"
                            render={<Link href={href} />}
                            nativeButton={false}
                          />
                        }
                      >
                        <span
                          className={cn(
                            (label === "Markets" || label === "Portfolio") &&
                              "text-base font-medium",
                          )}
                        >
                          {label}
                        </span>
                      </SheetClose>
                    ),
                )}
            </nav>
          </SheetContent>
        </Sheet>
      </div>
    </header>
  );
}
