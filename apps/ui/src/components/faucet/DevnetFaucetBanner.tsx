"use client";
import { useEffect, useState } from "react";
import { useWallet } from "@/components/providers/WalletProvider";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { protocolConfig } from "@/config/protocol";
import { SOLANA_DEVNET_GENESIS } from "@/lib/tokens/devnet";
import { reviewWithSession } from "@/lib/trading/review-session";
import { ApiError, requestJson } from "@/services/api";
import { refreshStores } from "@/stores/createResourceStore";

const CLAIMED_KEY = "probabl:faucet-claimed";
const claimedLocally = (owner: string) => {
  try {
    return (JSON.parse(window.localStorage.getItem(CLAIMED_KEY) ?? "[]") as string[]).includes(
      owner,
    );
  } catch {
    return false;
  }
};
const rememberClaim = (owner: string) => {
  try {
    const owners = JSON.parse(window.localStorage.getItem(CLAIMED_KEY) ?? "[]") as string[];
    window.localStorage.setItem(CLAIMED_KEY, JSON.stringify([...new Set([...owners, owner])]));
  } catch {
    // Storage is a convenience; the API remains the source of truth.
  }
};

interface ClaimResult {
  sent: { symbol: string; amount: string }[];
  unavailable: string[];
}

/** Devnet only: one-click claim of test assets from the server's faucet wallet. */
export function DevnetFaucetBanner() {
  const wallet = useWallet();
  const owner = wallet.account;
  const [available, setAvailable] = useState(false);
  const [claimed, setClaimed] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const devnet = protocolConfig.genesisHash === SOLANA_DEVNET_GENESIS;

  useEffect(() => {
    if (!devnet) return;
    const controller = new AbortController();
    const query = owner ? `?owner=${encodeURIComponent(owner)}` : "";
    if (owner && claimedLocally(owner)) setClaimed(owner);
    requestJson<{ available: boolean; claimed: boolean }>(`/v1/faucet/status${query}`, {
      signal: controller.signal,
    })
      .then((status) => {
        setAvailable(status.available);
        if (owner && status.claimed) {
          rememberClaim(owner);
          setClaimed(owner);
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [devnet, owner]);

  if (!devnet || !available || (owner && claimed === owner)) return null;

  const claim = async () => {
    if (claiming) return;
    if (!owner) {
      toast.add({
        type: "error",
        title: "Please login first to claim devnet assets",
      });
      return;
    }
    setClaiming(true);
    try {
      const result = await reviewWithSession<ClaimResult>({
        token: wallet.sessionToken,
        request: (token) =>
          requestJson<ClaimResult>("/v1/faucet/claim", {
            body: {},
            timeoutMs: 120_000,
            ...(token ? { token } : {}),
          }),
        authenticate: wallet.authenticate,
        assertCurrent: () => undefined,
      });
      rememberClaim(owner);
      setClaimed(owner);
      toast.add({
        type: "success",
        title: "Devnet assets transferred to your wallet",
        // Symbols only: wallets show scaled replica amounts (multipliers), not raw units.
        description: `Received ${result.sent.map((asset) => asset.symbol).join(", ")}.${
          result.unavailable.length
            ? ` ${result.unavailable.join(", ")} ran out and were skipped.`
            : ""
        } Use Deposit to start trading.`,
      });
      void refreshStores(["positions"]);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        rememberClaim(owner);
        setClaimed(owner);
      }
      toast.add({
        type: "error",
        title: error instanceof Error ? error.message : "Claiming devnet assets failed",
      });
    } finally {
      setClaiming(false);
    }
  };

  return (
    <div
      role="note"
      className="flex items-center justify-center gap-1 bg-primary/10 px-5 py-1.5 text-center text-sm text-primary"
    >
      <span>Deployed on Solana devnet.</span>
      <Button
        variant="link"
        size="sm"
        onClick={() => void claim()}
        disabled={claiming}
        aria-busy={claiming}
        className="h-auto px-0 font-medium text-primary underline underline-offset-2 disabled:opacity-80"
      >
        {claiming ? (
          <>
            <Spinner className="size-3.5" />
            Transferring devnet assets to your wallet…
          </>
        ) : (
          "Claim devnet assets to test"
        )}
      </Button>
    </div>
  );
}
