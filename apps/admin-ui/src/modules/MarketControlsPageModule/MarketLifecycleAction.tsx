"use client";
import { SolanaClient } from "@conditional-stocks/solana-client";
import {
  initializeMarketVaults,
  lifecycleTransaction,
} from "@conditional-stocks/solana-client/admin";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { useAdmin } from "@/components/providers/AdminProvider";
import { Button } from "@/components/ui/button";
import { adminConfig } from "@/config/protocol";
import { waitForAdminReceipt } from "@/lib/transactions";

export function MarketLifecycleAction({
  marketId,
  action,
  reason,
  baseTokens = [],
}: {
  marketId: string;
  action: "openMarket" | "freezeAtCutoff" | "freezeMarket";
  reason?: string;
  /** Evidence-ordered issuer tokens; any still unlisted are listed before opening. */
  baseTokens?: readonly string[];
}) {
  const admin = useAdmin(),
    cache = useQueryClient();
  const [reviewed, setReviewed] = useState(false),
    [busy, setBusy] = useState(false),
    [hash, setHash] = useState<string | null>(null);
  const lock = useRef(false);
  const transaction = lifecycleTransaction(
    adminConfig,
    admin.account ?? adminConfig.marketAdmin,
    marketId,
    action === "openMarket" ? 0 : action === "freezeAtCutoff" ? 2 : 1,
    reason,
  );
  const data = transaction.data;
  const label =
    action === "openMarket"
      ? "Open market"
      : action === "freezeAtCutoff"
        ? "Freeze at cutoff"
        : "Emergency freeze";
  const execute = async () => {
    if (lock.current || hash) return;
    lock.current = true;
    setBusy(true);
    try {
      if (action === "openMarket") {
        const setup = await initializeMarketVaults(
          new SolanaClient(adminConfig),
          marketId,
          transaction.from,
          baseTokens,
        );
        for (const step of setup) await admin.sendTransaction(step);
      }
      const submitted = await admin.sendTransaction(transaction);
      setHash(submitted);
      toast.success("Lifecycle transaction submitted. Waiting for confirmation.");
      await waitForAdminReceipt(submitted);
      await cache.invalidateQueries({ queryKey: ["markets"] });
      toast.success("Confirmed. Market state updates after indexing.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Lifecycle transaction failed");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="mt-4 flex flex-col gap-3">
      {reviewed && (
        <div className="rounded-lg bg-secondary p-3 text-xs leading-6">
          <p>
            {label} on {adminConfig.chainName}. This costs SOL. Opening first submits any missing
            issuer listing and claim-mint transactions separately. The program requires the quote
            claims, every listed leg initialized and at least one active leg. The live program
            checks timing and wallet roles before the wallet request.
          </p>
          <p className="break-all font-mono">Registry: {transaction.to}</p>
          <p className="break-all font-mono">Market: {marketId}</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              navigator.clipboard
                .writeText(JSON.stringify({ to: transaction.to, data, value: "0" }, null, 2))
                .then(() => toast.success("Solana instruction payload copied"))
                .catch(() => toast.error("Clipboard unavailable"))
            }
          >
            Copy instructions
          </Button>
        </div>
      )}
      <Button
        variant="outline"
        disabled={busy || admin.signing || Boolean(hash)}
        onClick={() => (reviewed ? execute() : setReviewed(true))}
      >
        {busy ? "Waiting for wallet / chain…" : `${reviewed ? "Sign" : "Review"} · ${label}`}
      </Button>
      {hash && (
        <p role="status" className="break-all font-mono text-xs">
          Submitted: {hash}. Check its receipt before retrying.
        </p>
      )}
    </div>
  );
}
