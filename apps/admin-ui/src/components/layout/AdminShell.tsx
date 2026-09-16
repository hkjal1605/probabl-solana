"use client";

import {
  Activity,
  ClipboardCheck,
  FileClock,
  Gavel,
  History,
  LayoutDashboard,
  Menu,
  Moon,
  PlusCircle,
  Settings2,
  Sun,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AdminLogo } from "@/components/brand/AdminLogo";
import { useAdmin } from "@/components/providers/AdminProvider";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { adminConfig } from "@/config/protocol";
import { short } from "@/lib/format";
import { cn } from "@/lib/utils";

const nav = [
  { href: "/", icon: LayoutDashboard, label: "Overview" },
  { href: "/markets/new", icon: PlusCircle, label: "Create market" },
  { href: "/review", icon: ClipboardCheck, label: "Review queue" },
  { href: "/markets", icon: Settings2, label: "Market controls" },
  { href: "/resolutions", icon: Gavel, label: "Resolution" },
  { href: "/system", icon: Activity, label: "System health" },
  { href: "/history", icon: History, label: "Audit history" },
];
function Navigation({ mobile = false }: { mobile?: boolean }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1" aria-label="Operator navigation">
      {nav.map((item) => {
        const active =
          pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
        const className = cn(
          buttonVariants({ variant: "ghost" }),
          "w-full justify-start px-3 text-sm",
          active && "bg-muted text-foreground",
        );
        return mobile ? (
          <SheetClose
            key={item.href}
            nativeButton={false}
            render={<Link href={item.href} className={className} />}
          >
            <item.icon data-icon="inline-start" />
            {item.label}
          </SheetClose>
        ) : (
          <Link key={item.href} href={item.href} className={className}>
            <item.icon data-icon="inline-start" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
export function AdminShell({ children }: { children: React.ReactNode }) {
  const admin = useAdmin();
  const allowed = admin.role === "operator";
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <div className="min-h-svh lg:grid lg:grid-cols-[224px_1fr]">
      <aside className="sticky top-0 hidden h-svh border-r bg-background p-4 lg:flex lg:flex-col">
        <AdminLogo />
        <p className="mt-2 text-xs font-medium text-muted-foreground">Operations</p>
        <div className="mt-8">
          <Navigation />
        </div>
        <div className="mt-auto rounded-xl bg-card p-3 text-xs">
          <p className="font-medium">Authority boundary</p>
          <p className="mt-1 leading-5 text-muted-foreground">
            This UI prepares and verifies actions. Roles and Solana signatures remain enforced
            outside it.
          </p>
        </div>
      </aside>
      <div className="min-w-0">
        <header className="sticky top-0 z-40 flex h-12 items-center gap-2 border-b bg-background px-3 sm:gap-3 sm:px-5">
          <div className="lg:hidden">
            <Sheet>
              <SheetTrigger
                render={
                  <Button size="icon-sm" variant="ghost" aria-label="Open operator navigation" />
                }
              >
                <Menu />
              </SheetTrigger>
              <SheetContent side="left">
                <SheetHeader>
                  <SheetTitle>
                    <AdminLogo />
                  </SheetTitle>
                  <SheetDescription>probabl operations</SheetDescription>
                </SheetHeader>
                <div className="mt-8">
                  <Navigation mobile />
                </div>
              </SheetContent>
            </Sheet>
          </div>
          <div className="lg:hidden">
            <AdminLogo />
          </div>
          <span className="hidden text-sm font-medium text-foreground lg:block">Operations</span>
          <Button
            className="ml-auto"
            variant="ghost"
            size="icon-sm"
            disabled={!mounted}
            aria-label={
              mounted
                ? `Switch to ${resolvedTheme === "dark" ? "light" : "dark"} theme`
                : "Change color theme"
            }
            onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          >
            {mounted && resolvedTheme === "dark" ? <Sun /> : <Moon />}
          </Button>
          <Badge
            className="hidden sm:inline-flex"
            variant={admin.chainId === adminConfig.chainId ? "positive" : "warning"}
          >
            {admin.chainId === null
              ? "No network"
              : admin.chainId === adminConfig.chainId
                ? adminConfig.chainName
                : `Chain ${admin.chainId}`}
          </Badge>
          {admin.account ? (
            <Button
              variant="outline"
              className="size-7 px-0 sm:w-auto sm:px-3"
              aria-label={`Disconnect operator ${short(admin.account)}`}
              onClick={admin.disconnect}
            >
              <FileClock />
              <span className="hidden sm:inline">{short(admin.account)}</span>
            </Button>
          ) : (
            <Button
              variant="default"
              className="size-7 px-0 sm:w-auto sm:px-3"
              aria-label="Connect operator"
              disabled={admin.restoring}
              onClick={() =>
                admin
                  .connect()
                  .catch((cause) =>
                    toast.error(cause instanceof Error ? cause.message : "Connect failed"),
                  )
              }
            >
              <Wallet className="sm:hidden" aria-hidden="true" />
              <span className="hidden sm:inline">Connect operator</span>
            </Button>
          )}
        </header>
        {admin.persistenceError && (
          <p role="status" className="border-b px-5 py-3 text-sm text-warning">
            {admin.persistenceError}
          </p>
        )}
        {admin.restoring ? (
          <main
            className="flex min-h-[75svh] items-center justify-center px-5 text-muted-foreground"
            role="status"
            aria-label="Restoring operator session"
          >
            <Spinner className="size-5" />
          </main>
        ) : !admin.account || !admin.token || !allowed || admin.chainId !== adminConfig.chainId ? (
          <main className="mx-auto flex min-h-[75svh] max-w-xl flex-col items-center justify-center px-5 text-center">
            <ClipboardCheck className="size-9 text-brand-strong" />
            <h1 className="mt-5 text-3xl font-semibold tracking-[-0.04em]">
              Operator authentication required
            </h1>
            <p className="mt-3 leading-7 text-muted-foreground">
              Connect an authorized operator wallet and sign a session challenge. Frontend role
              checks are only a convenience; the API and contracts enforce authority. Your wallet
              reconnects on refresh, and sign-in is remembered for four hours unless you disconnect.
            </p>
            {admin.networkError ? (
              <p className="mt-6 text-sm text-destructive" role="alert">
                {admin.networkError}
              </p>
            ) : null}
            {admin.role === "blocked" ? (
              <Badge className="mt-6" variant="destructive">
                This wallet has no operator role in the configured Solana deployment
              </Badge>
            ) : admin.account &&
              (admin.role === "unverified" || admin.chainId !== adminConfig.chainId) ? (
              <Button
                className="mt-6"
                variant="default"
                disabled={admin.checkingNetwork}
                onClick={() =>
                  admin
                    .ensureNetwork()
                    .catch((error) =>
                      toast.error(
                        error instanceof Error ? error.message : "Network verification failed",
                      ),
                    )
                }
              >
                {admin.checkingNetwork
                  ? "Checking on-chain operator roles…"
                  : `Verify ${adminConfig.chainName} connection`}
              </Button>
            ) : admin.account ? (
              <Button
                className="mt-6"
                variant="default"
                disabled={admin.signing}
                onClick={() =>
                  admin
                    .authenticate()
                    .catch((cause) =>
                      toast.error(cause instanceof Error ? cause.message : "Sign-in failed"),
                    )
                }
              >
                {admin.signing ? "Signing in…" : "Sign operator challenge"}
              </Button>
            ) : (
              <Button
                className="mt-6"
                variant="default"
                onClick={() =>
                  admin
                    .connect()
                    .catch((cause) =>
                      toast.error(cause instanceof Error ? cause.message : "Connect failed"),
                    )
                }
              >
                Connect wallet
              </Button>
            )}
          </main>
        ) : (
          <div key={`${admin.account}:${admin.chainId}`}>{children}</div>
        )}
      </div>
    </div>
  );
}
