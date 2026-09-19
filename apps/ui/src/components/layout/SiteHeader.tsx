"use client";
import { Menu } from "lucide-react";
import Link from "next/link";
import { Logo } from "@/components/brand/Logo";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { HeaderAccountControls } from "@/components/wallet/HeaderAccountControls";
import { MarketSearch } from "@/modules/MarketSearchModule";

export function SiteHeader() {
  return (
    <header className="relative z-40 flex h-14 shrink-0 items-center gap-4 border-b bg-background px-3 sm:h-12 sm:gap-6">
      <Logo />
      <div className="absolute left-1/2 -translate-x-1/2">
        <MarketSearch />
      </div>
      <div className="ml-auto flex items-center gap-2">
        <HeaderAccountControls />
        <Sheet>
          <SheetTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                className="md:hidden"
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
              <SheetClose
                nativeButton={false}
                render={
                  <Button
                    variant="ghost"
                    className="justify-start"
                    render={<Link href="/orders" />}
                    nativeButton={false}
                  />
                }
              >
                Orders
              </SheetClose>
            </nav>
          </SheetContent>
        </Sheet>
      </div>
    </header>
  );
}
