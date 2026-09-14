"use client";
import { CheckCircle2, LogOut, Network, WalletCards } from "lucide-react";
import { useWallet } from "@/components/providers/WalletProvider";
import { Alert, AlertDescription } from "@/components/ui/alert";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Item, ItemContent } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { protocolConfig } from "@/config/protocol";
import { shortAddress } from "@/lib/format/display";

export function WalletButton({ compact = false }: { compact?: boolean }) {
  const wallet = useWallet();
  const connecting = wallet.restoring || wallet.status === "connecting";
  if (wallet.account) {
    const wrongNetwork = wallet.chainId !== protocolConfig.chainId;
    return (
      <Dialog>
        <DialogTrigger
          render={
            <Button
              variant={wrongNetwork ? "destructive" : "outline"}
              size={compact ? "icon" : "default"}
              className={compact ? undefined : "px-2 sm:px-4"}
              aria-label="Wallet details"
            />
          }
        >
          <WalletCards />
          {!compact && <span className="hidden sm:inline">{shortAddress(wallet.account)}</span>}
        </DialogTrigger>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Your trading wallet</DialogTitle>
            <DialogDescription>
              Self-custodied. Every order is signed by this wallet and settles onchain.
            </DialogDescription>
          </DialogHeader>
          <Item variant="outline">
            <ItemContent>
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
            </ItemContent>
          </Item>
          {wallet.persistenceError && (
            <p role="status" className="text-sm text-warning">
              {wallet.persistenceError}
            </p>
          )}
          {wallet.error && (
            <Alert variant="destructive">
              <AlertDescription>{wallet.error}</AlertDescription>
            </Alert>
          )}
          {wrongNetwork && (
            <Button
              variant="default"
              onClick={() =>
                wallet
                  .ensureNetwork()
                  .catch(() => toast.add({ type: "error", title: "Network switch was rejected" }))
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
                  .then(() => toast.add({ type: "success", title: "Trading session ready" }))
                  .catch((cause) =>
                    toast.add({
                      type: "error",
                      title: cause instanceof Error ? cause.message : "Sign-in failed",
                    }),
                  )
              }
            >
              {wallet.status === "signing" && <Spinner data-icon="inline-start" />}
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
      variant="default"
      size={compact ? "icon" : "default"}
      className={compact ? undefined : "px-2 sm:px-4"}
      disabled={connecting}
      onClick={() =>
        wallet.connect().catch((cause) =>
          toast.add({
            type: "error",
            title: cause instanceof Error ? cause.message : "Wallet connection failed",
          }),
        )
      }
      aria-label={connecting ? "Restoring wallet connection" : "Connect wallet"}
    >
      {connecting ? <Spinner data-icon="inline-start" /> : <WalletCards data-icon="inline-start" />}
      {!compact && (
        <span className="hidden sm:inline">{connecting ? "Connecting…" : "Connect wallet"}</span>
      )}
    </Button>
  );
}
