"use client";
import { refreshStores } from "@/stores/createResourceStore";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useWallet } from "@/components/providers/WalletProvider";
import { protocolConfig } from "@/config/protocol";
import { api } from "@/services/protocol-api-service";
import { orderRecovery, type RecoveryKind, verifyRecoveryResponse } from "@/lib/trading/recovery";
import { transactionReceipt } from "@/lib/trading/rpc";
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
        const expected = await orderRecovery({
          orderHash,
          kind,
          account: wallet.account,
          config: protocolConfig,
        });
        if (wallet.chainId !== protocolConfig.chainId) await wallet.ensureNetwork();
        const token = wallet.sessionToken ?? (await wallet.authenticate());
        const prepared = await api.prepare<unknown>(
          `orders/${kind === "cancel" ? "cancel" : "recovery"}/prepare`,
          { orderHash, kind },
          token,
        );
        assertCurrent();
        const hash = await wallet.sendTransaction(verifyRecoveryResponse(expected, prepared));
        setPending((previous) => new Set(previous).add(orderHash));
        toast.success(`Cancellation submitted: ${hash.slice(0, 10)}… Waiting for confirmation.`);
        try {
          const receipt = await transactionReceipt(hash);
          assertCurrent();
          if (receipt.status !== "success")
            throw new Error("Cancellation reverted. Refresh the order before retrying.");
          toast.success("Cancellation confirmed. Escrow release will appear after indexing.");
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
