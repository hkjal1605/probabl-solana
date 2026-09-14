"use client";
import { Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { MarketSearchResults } from "./components/MarketSearchResults";
import { useSearchMarkets } from "./hooks/useSearchMarkets";
import { shouldOpenMarketSearch } from "./utils/searchMarkets";

function Content({ close }: { close: () => void }) {
  const data = useSearchMarkets();
  const router = useRouter();
  return (
    <MarketSearchResults
      {...data}
      onSelect={(market) => {
        close();
        router.push(`/markets/${encodeURIComponent(market.id)}`);
      }}
    />
  );
}

export function MarketSearch() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!shouldOpenMarketSearch(event)) return;
      event.preventDefault();
      trigger.current?.click();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, []);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        ref={trigger}
        aria-label="Search markets"
        aria-keyshortcuts="/"
        render={<Button variant="search" className="gap-2 px-2 sm:pl-3" />}
      >
        <Search data-icon="inline-start" />
        <span className="hidden lg:inline">Search market or address...</span>
        <Kbd className="hidden lg:inline-flex">/</Kbd>
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className="top-[min(18vh,160px)] max-h-[80dvh] -translate-y-0 gap-3 overflow-y-auto sm:max-w-[560px]"
      >
        <DialogHeader className="flex-row items-center justify-between">
          <DialogTitle>
            <span className="text-lg">Search markets</span>
          </DialogTitle>
          <DialogClose render={<Button variant="ghost" size="icon-sm" aria-label="Close search" />}>
            <X />
          </DialogClose>
          <DialogDescription className="sr-only">
            Find a market by event, token name, symbol or mint address.
          </DialogDescription>
        </DialogHeader>
        {open && <Content close={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  );
}
