"use client";
import { InfoIcon, XIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Separator } from "@/components/ui/separator";
import { formatTime } from "@/lib/format/display";
import type { MarketView } from "@/types/api";
import { rulesTextParts, safeRulesLink } from "../utils/rulesText";

export function MarketRulesDialog({ market }: { market: MarketView }) {
  const source = safeRulesLink(market.mapping.polymarketUrl);
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="link" size="sm" />}>Rules</DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[640px]"
      >
        <DialogHeader className="gap-2 px-6 pt-5 pb-4">
          <div className="flex items-center justify-between gap-3">
            <DialogTitle>
              <span className="text-lg leading-6">Rules</span>
            </DialogTitle>
            <DialogClose
              render={<Button variant="ghost" size="icon-sm" aria-label="Close rules" />}
            >
              <XIcon />
            </DialogClose>
          </div>
          <DialogDescription>{market.question}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 pb-6">
          <div className="whitespace-pre-line text-base leading-6 [overflow-wrap:anywhere]">
            {rulesTextParts(market.description).map((part) =>
              part.href ? (
                <a
                  key={part.offset}
                  href={part.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline underline-offset-4"
                >
                  {part.text}
                </a>
              ) : (
                <span key={part.offset}>{part.text}</span>
              ),
            )}
          </div>
          <Separator />
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <dt className="text-muted-foreground">Trading opens</dt>
              <dd>{formatTime(market.tradingOpen)}</dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-muted-foreground">Trading cutoff</dt>
              <dd>{formatTime(market.cutoff)}</dd>
            </div>
          </dl>
          <Alert role="note" className="p-4">
            <InfoIcon />
            <AlertTitle>Market resolution</AlertTitle>
            <AlertDescription>
              These are the saved reference rules. Our market admin reviews the evidence and settles
              this market on Solana. Polymarket does not directly settle your positions here.
            </AlertDescription>
          </Alert>
          {source && (
            <a
              href={source}
              target="_blank"
              rel="noopener noreferrer"
              className="self-start text-sm text-primary hover:underline underline-offset-4"
            >
              View on Polymarket ↗
            </a>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
