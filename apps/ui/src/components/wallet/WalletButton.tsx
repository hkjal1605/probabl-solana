"use client";
import {
  BriefcaseBusiness,
  CheckCircle2,
  Landmark,
  ListOrdered,
  LogOut,
  Moon,
  Network,
  Settings2,
  Sun,
  WalletCards,
} from "lucide-react";
import Link from "next/link";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";
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
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Item, ItemContent } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { protocolConfig } from "@/config/protocol";
import { shortAddress } from "@/lib/format/display";
import { cn } from "@/lib/utils";
import { AccountAvatar } from "./AccountAvatar";
import { useWalletLogin } from "./WalletLoginProvider";

export function WalletButton({ compact = false }: { compact?: boolean }) {
  const wallet = useWallet();
  const login = useWalletLogin();
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [walletDetailsOpen, setWalletDetailsOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { resolvedTheme, setTheme } = useTheme();
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );
  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setAccountMenuOpen(false), 140);
  };
  const showPlaceholder = (label: string) => (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    toast.add({ type: "info", title: `${label} is coming soon` });
  };
  const connecting = wallet.restoring || wallet.status === "connecting";
  if (wallet.account) {
    const wrongNetwork = wallet.chainId !== protocolConfig.chainId;
    return (
      <>
        <DropdownMenu
          open={accountMenuOpen}
          onOpenChange={(open) => {
            if (open) cancelClose();
            setAccountMenuOpen(open);
          }}
        >
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="account-menu-trigger size-5 rounded-full border-0 p-0 hover:bg-transparent aria-expanded:bg-transparent focus-visible:border-0 focus-visible:ring-0 dark:hover:bg-transparent sm:size-[25px]"
                aria-label="Account menu"
              />
            }
            onPointerEnter={(event) => {
              if (event.pointerType === "mouse") {
                cancelClose();
                setAccountMenuOpen(true);
              }
            }}
            onPointerLeave={(event) => {
              if (event.pointerType === "mouse") scheduleClose();
            }}
          >
            <AccountAvatar account={wallet.account} size="header" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            sideOffset={8}
            className="account-menu w-64 rounded-xl bg-secondary p-0 shadow-xl"
            onPointerEnter={(event) => {
              if (event.pointerType === "mouse") cancelClose();
            }}
            onPointerLeave={(event) => {
              if (event.pointerType === "mouse") scheduleClose();
            }}
          >
            <DropdownMenuGroup>
              <div className="flex items-center gap-3 px-4 py-3.5">
                <AccountAvatar account={wallet.account} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-foreground">My account</p>
                  <p className="truncate text-xs text-muted-foreground" title={wallet.account}>
                    {shortAddress(wallet.account, 6)}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="focus-visible:border-0 focus-visible:bg-accent focus-visible:ring-0"
                  aria-label="Wallet settings"
                  onClick={() => {
                    setAccountMenuOpen(false);
                    setWalletDetailsOpen(true);
                  }}
                >
                  <Settings2 />
                </Button>
              </div>
            </DropdownMenuGroup>
            <DropdownMenuSeparator className="mx-0 my-0" />
            <DropdownMenuGroup className="p-2">
              <DropdownMenuItem
                render={<Link href="/portfolio" />}
                className="gap-3 px-3 py-2.5 font-medium"
              >
                <BriefcaseBusiness /> Portfolio
              </DropdownMenuItem>
              <DropdownMenuItem
                render={<Link href="/orders" />}
                className="gap-3 px-3 py-2.5 font-medium"
              >
                <ListOrdered /> Open orders
              </DropdownMenuItem>
              <DropdownMenuItem
                render={<Link href="/funds" />}
                className="gap-3 px-3 py-2.5 font-medium"
              >
                <Landmark /> Funds
              </DropdownMenuItem>
              <DropdownMenuCheckboxItem
                checked={resolvedTheme === "dark"}
                onCheckedChange={(checked) => setTheme(checked ? "dark" : "light")}
                className="gap-3 px-3 py-2.5 font-medium [&_[data-slot=dropdown-menu-checkbox-item-indicator]]:hidden"
              >
                {resolvedTheme === "dark" ? <Moon /> : <Sun />}
                Dark mode
                <span
                  aria-hidden="true"
                  className={cn(
                    "ml-auto flex h-5 w-9 items-center rounded-full bg-muted-foreground/40 p-0.5 transition-colors",
                    resolvedTheme === "dark" && "bg-primary",
                  )}
                >
                  <span
                    className={cn(
                      "size-4 rounded-full bg-background transition-transform",
                      resolvedTheme === "dark" && "translate-x-4",
                    )}
                  />
                </span>
              </DropdownMenuCheckboxItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator className="mx-0 my-0" />
            <DropdownMenuGroup className="p-2">
              {(["Support", "Terms of use", "Privacy policy"] as const).map((label) => (
                <DropdownMenuItem
                  key={label}
                  render={<a href="#" onClick={showPlaceholder(label)} />}
                  className="px-3 py-2 text-muted-foreground"
                >
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator className="mx-0 my-0" />
            <DropdownMenuGroup className="p-2">
              <DropdownMenuItem
                variant="destructive"
                className="px-3 py-2.5"
                onClick={() => wallet.disconnect()}
              >
                <LogOut /> Disconnect
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Dialog open={walletDetailsOpen} onOpenChange={setWalletDetailsOpen}>
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
            <Button
              variant="ghost"
              onClick={() => {
                wallet.disconnect();
                setWalletDetailsOpen(false);
              }}
            >
              <LogOut />
              Disconnect locally
            </Button>
          </DialogContent>
        </Dialog>
      </>
    );
  }
  return (
    <Button
      variant="default"
      size={compact ? "icon" : "default"}
      className={compact ? undefined : "px-2 sm:px-4"}
      disabled={connecting}
      onClick={login}
      aria-label="Login"
    >
      {connecting ? <Spinner data-icon="inline-start" /> : <WalletCards data-icon="inline-start" />}
      {!compact && <span className="hidden sm:inline">Login</span>}
    </Button>
  );
}
