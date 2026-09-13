"use client";
import type { AdminDeployment } from "@conditional-stocks/solana-client/admin";
import { Button } from "@conditional-stocks/ui-kit/button";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { useAdmin } from "@/components/providers/AdminProvider";
import { adminConfig } from "@/config/protocol";
import { type AdminPreview, adminRequest, type EvidenceView } from "@/lib/admin-api";
import { verifyAdminPreview, waitForAdminReceipt } from "@/lib/transactions";

export function ExecuteEvidence({
  packet,
  preview,
  onDone,
  deployment = adminConfig,
}: {
  packet: EvidenceView;
  preview: AdminPreview;
  onDone: () => void;
  deployment?: AdminDeployment;
}) {
  const admin = useAdmin(),
    cache = useQueryClient();
  const [busy, setBusy] = useState(false),
    [hash, setHash] = useState<string | null>(null),
    [confirmed, setConfirmed] = useState(false);
  const lock = useRef(false);
  const authority = admin.account === preview.from;
  const execute = async () => {
    if (lock.current || hash) return;
    lock.current = true;
    setBusy(true);
    const assertContext = admin.captureContext();
    try {
      const expected = verifyAdminPreview(packet, preview, deployment);
      const current = await adminRequest<AdminPreview>(
        admin.token ?? "",
        `admin/evidence/${packet.envelope.packetHash}/transaction`,
        { method: "POST", body: "{}" },
      );
      const refreshed = verifyAdminPreview(packet, current, deployment);
      assertContext();
      if (
        current.action !== preview.action ||
        JSON.stringify(expected) !== JSON.stringify(refreshed)
      )
        throw new Error("Market state changed. Refresh and review the next action before signing.");
      const submitted = await admin.sendTransaction(expected);
      setHash(submitted);
      toast.success("Transaction submitted. Waiting for chain confirmation; the indexer may lag.");
      await waitForAdminReceipt(submitted);
      setConfirmed(true);
      await cache.invalidateQueries({ queryKey: ["markets"] });
      onDone();
      toast.success("Transaction confirmed. Reconcile its hash below once indexed.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Transaction failed");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="mt-4 space-y-3 border-t pt-4">
      <p className="text-sm text-muted-foreground">
        This is a real onchain transaction and costs SOL.{" "}
        {authority
          ? "Verify the action and evidence above before signing."
          : "Connect the required Solana authority wallet to execute directly. Multisig execution requires a separately reviewed integration."}
      </p>
      <Button
        variant="brand"
        disabled={!authority || busy || admin.signing || Boolean(hash)}
        onClick={execute}
      >
        {busy ? "Waiting for wallet / chain…" : `Sign ${preview.action.replaceAll("-", " ")}`}
      </Button>
      {hash && (
        <p role="status" className="break-all font-mono text-xs">
          {confirmed ? "Confirmed" : "Submitted — check receipt before retrying"}: {hash}
        </p>
      )}
    </div>
  );
}
