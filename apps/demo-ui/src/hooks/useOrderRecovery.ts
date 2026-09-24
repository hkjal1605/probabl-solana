"use client";
import { useEffect, useState } from "react";
import { useWallet } from "@/components/providers/WalletProvider";
import { toast } from "@/components/ui/toast";
import { orderRecovery, type RecoveryKind } from "@/lib/trading/recovery";
import { transactionReceipt } from "@/lib/trading/rpc";
import { refreshStores } from "@/stores/createResourceStore";
import { useAsyncAction } from "./useAsyncAction";
import { useOrders } from "./useProtocolData";

export function useOrderRecovery() {
  const wallet = useWallet(),
    query = useOrders();
  const [canceling, setCanceling] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const { run } = useAsyncAction(wallet.account ?? "");
  // biome-ignore lint/correctness/useExhaustiveDependencies: Pending actions belong only to the connected account.
  useEffect(() => {
    setPending(new Set());
    setCanceling(null);
  }, [wallet.account]);
  useEffect(() => {
    if (!query.data) return;
    const open = new Set(query.data.orders.filter((o) => o.status === "open").map((o) => o.id));
    setPending((previous) => {
      const next = new Set([...previous].filter((id) => open.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [query.data]);
  const cancel = (orderHash: string, kind: RecoveryKind = "cancel") =>
    run(async (assertCurrent) => {
      if (pending.has(orderHash)) return;
      setCanceling(orderHash);
      try {
        if (!wallet.account) throw new Error("Connect your wallet.");
        const prepared = await orderRecovery({ orderHash, kind, account: wallet.account });
        assertCurrent();
        await wallet.ensureNetwork();
        const hash = await wallet.sendTransaction(prepared);
        setPending((previous) => new Set(previous).add(orderHash));
        toast.add({
          type: "success",
          title: `Cancellation submitted: ${hash.slice(0, 10)}… Waiting for confirmation.`,
        });
        try {
          const receipt = await transactionReceipt(hash);
          assertCurrent();
          if (receipt.status !== "success")
            throw new Error("Cancellation reverted. Refresh the order before retrying.");
          toast.add({
            type: "success",
            title: "Cancellation confirmed. Escrow release will appear after indexing.",
          });
        } catch (error) {
          assertCurrent();
          // A failed or unconfirmed transaction must not disable recovery forever.
          setPending((previous) => {
            const next = new Set(previous);
            next.delete(orderHash);
            return next;
          });
          throw error;
        }
        await refreshStores(["wallet-orders", "positions", "payout-credits"]);
      } finally {
        setCanceling(null);
      }
    });
  return { ...query, cancel, canceling, pending };
}
