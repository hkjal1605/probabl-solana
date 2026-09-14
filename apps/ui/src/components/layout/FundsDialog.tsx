"use client";
import { useUiStore } from "@/components/providers/UiStateProvider";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useMarkets } from "@/hooks/useProtocolData";
import { FundsClient } from "@/modules/FundsPageModule/components/FundsClient";

function Content() {
  const { markets } = useMarkets();
  return <FundsClient markets={markets} embedded />;
}
export function FundsDialog() {
  const tab = useUiStore((state) => state.funds),
    setFunds = useUiStore((state) => state.setFunds);
  return (
    <Dialog
      open={tab !== null}
      onOpenChange={(open) => {
        if (!open) setFunds(null);
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Funds</DialogTitle>
          <DialogDescription>
            Fund your wallet directly. Trading reservations enter contract escrow only when you
            authorize an order.
          </DialogDescription>
        </DialogHeader>
        {tab && <Content />}
      </DialogContent>
    </Dialog>
  );
}
