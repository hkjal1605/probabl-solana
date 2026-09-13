"use client";

import { Badge } from "@conditional-stocks/ui-kit/badge";
import { Button } from "@conditional-stocks/ui-kit/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@conditional-stocks/ui-kit/dialog";
import { CheckCircle2, LogOut, Network, WalletCards } from "lucide-react";
import { toast } from "sonner";
import { useWallet } from "@/components/providers/WalletProvider";
import { protocolConfig } from "@/config/protocol";
import { shortAddress } from "@/lib/format/display";

export function WalletButton({ compact = false }: { compact?: boolean }) {
  const wallet = useWallet();
  const connecting = wallet.restoring || wallet.status === "connecting";
  if (wallet.account) {
    const wrongNetwork = wallet.chainId !== protocolConfig.chainId;
    return (
      <Dialog>
        <DialogTrigger asChild>
          <Button
            variant={wrongNetwork ? "destructive" : "outline"}
            size={compact ? "icon" : "default"}
            className={compact ? undefined : "px-2 sm:px-4"}
            aria-label="Wallet details"
          >
            <WalletCards />
            {!compact && <span className="hidden sm:inline">{shortAddress(wallet.account)}</span>}
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Your trading wallet</DialogTitle>
            <DialogDescription>
              Self-custodied. Every order is signed by this wallet and settles onchain.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 rounded-xl border bg-muted/45 p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Account</span>
              <code className="text-xs">{shortAddress(wallet.account, 6)}</code>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Network</span>
              <Badge variant={wrongNetwork ? "destructive" : "positive"}>
                {wrongNetwork ? "Switch required" : protocolConfig.chainName}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Trading session</span>
              <Badge variant={wallet.sessionToken ? "positive" : "warning"}>
                {wallet.sessionToken ? (
                  <>
                    <CheckCircle2 />
                    Signed in
                  </>
                ) : (
                  "Signature needed"
                )}
              </Badge>
            </div>
          </div>
          {wallet.persistenceError && (
            <p role="status" className="text-sm text-warning">
              {wallet.persistenceError}
            </p>
          )}
          {wallet.error && (
            <p role="alert" className="text-sm text-danger">
              {wallet.error}
            </p>
          )}
          {wrongNetwork && (
            <Button
              variant="brand"
              onClick={() =>
                wallet.ensureNetwork().catch(() => toast.error("Network switch was rejected"))
              }
            >
              <Network />
              Switch network
            </Button>
          )}
          {!wallet.sessionToken && (
            <Button
              disabled={wallet.status === "signing" || connecting || wrongNetwork}
              onClick={() =>
                wallet
                  .authenticate()
                  .then(() => toast.success("Trading session ready"))
                  .catch((cause) =>
                    toast.error(cause instanceof Error ? cause.message : "Sign-in failed"),
                  )
              }
            >
              {wallet.status === "signing" ? "Signing in…" : "Sign in to trade"}
            </Button>
          )}
          <Button variant="ghost" onClick={() => wallet.disconnect()}>
            <LogOut />
            Disconnect locally
          </Button>
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Button
      variant="brand"
      size={compact ? "icon" : "default"}
      className={compact ? undefined : "px-2 sm:px-4"}
      disabled={connecting}
      onClick={() =>
        wallet
          .connect()
          .catch((cause) =>
            toast.error(cause instanceof Error ? cause.message : "Wallet connection failed"),
          )
      }
      aria-label={connecting ? "Restoring wallet connection" : "Connect wallet"}
    >
      <WalletCards />
      {!compact && (
        <span className="hidden sm:inline">{connecting ? "Connecting…" : "Connect wallet"}</span>
      )}
    </Button>
  );
}
