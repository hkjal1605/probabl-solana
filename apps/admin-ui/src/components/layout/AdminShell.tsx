"use client";

import { Badge } from "@conditional-stocks/ui-kit/badge";
import { Button } from "@conditional-stocks/ui-kit/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@conditional-stocks/ui-kit/sheet";
import { ThemeSelect } from "@conditional-stocks/ui-kit/theme";
import { cn } from "@conditional-stocks/ui-kit/utils";
import {
  Activity,
  ClipboardCheck,
  FileClock,
  Gavel,
  History,
  LayoutDashboard,
  Menu,
  PlusCircle,
  Settings2,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import { AdminLogo } from "@/components/brand/AdminLogo";
import { useAdmin } from "@/components/providers/AdminProvider";
import { adminConfig } from "@/config/protocol";
import { short } from "@/lib/format";

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
    <nav className="space-y-1" aria-label="Operator navigation">
      {nav.map((item) => {
        const link = (
          <Button
            key={item.href}
            asChild
            variant="ghost"
            className={cn(
              "w-full justify-start",
              (pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href))) &&
                "bg-accent text-accent-foreground",
            )}
          >
            <Link href={item.href}>
              <item.icon />
              {item.label}
            </Link>
          </Button>
        );
        return mobile ? (
          <SheetClose asChild key={item.href}>
            {link}
          </SheetClose>
        ) : (
          link
        );
      })}
    </nav>
  );
}
export function AdminShell({ children }: { children: React.ReactNode }) {
  const admin = useAdmin();
  const allowed = admin.role !== "blocked";
  return (
    <div className="min-h-svh lg:grid lg:grid-cols-[250px_1fr]">
      <aside className="sticky top-0 hidden h-svh border-r bg-sidebar p-5 lg:flex lg:flex-col">
        <AdminLogo />
        <p className="mt-3 text-xs font-semibold tracking-widest text-muted-foreground uppercase">
          Operations
        </p>
        <div className="mt-10">
          <Navigation />
        </div>
        <div className="mt-auto rounded-xl border bg-card p-3 text-xs">
          <p className="font-semibold">Authority boundary</p>
          <p className="mt-1 leading-5 text-muted-foreground">
            This UI prepares and verifies actions. Roles and Solana signatures remain enforced outside
            it.
          </p>
        </div>
      </aside>
      <div className="min-w-0">
        <header className="sticky top-0 z-40 flex h-18 items-center gap-2 border-b bg-background/85 px-4 backdrop-blur-xl sm:gap-3 sm:px-8">
          <div className="lg:hidden">
            <Sheet>
              <SheetTrigger asChild>
                <Button size="icon-sm" variant="outline" aria-label="Open operator navigation">
                  <Menu />
                </Button>
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
          <AdminLogo />
          <span className="hidden text-xs font-semibold text-muted-foreground xl:block">
            Operations
          </span>
          <div className="ml-auto">
            <ThemeSelect />
          </div>
          <Badge
            className="hidden md:inline-flex"
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
              className="size-10 px-0 sm:w-auto sm:px-4"
              aria-label={`Disconnect operator ${short(admin.account)}`}
              onClick={admin.disconnect}
            >
              <FileClock />
              <span className="hidden sm:inline">{short(admin.account)}</span>
            </Button>
          ) : (
            <Button
              variant="brand"
              className="size-10 px-0 sm:w-auto sm:px-4"
              aria-label="Connect operator"
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
        {!admin.account || !admin.token || !allowed || admin.chainId !== adminConfig.chainId ? (
          <main className="mx-auto flex min-h-[75svh] max-w-xl flex-col items-center justify-center px-5 text-center">
            <ClipboardCheck className="size-9 text-brand-strong" />
            <h1 className="mt-5 text-3xl font-semibold tracking-[-0.04em]">
              Operator authentication required
            </h1>
            <p className="mt-3 leading-7 text-muted-foreground">
              Connect an authorized operator wallet and sign a session challenge. Frontend role
              checks are only a convenience; the API and contracts enforce authority.
            </p>
            {admin.role === "blocked" ? (
              <Badge className="mt-6" variant="destructive">
                {adminConfig.marketAdmin
                  ? "Connect an authorized operator wallet"
                  : "MARKET_ADMIN address is not configured for this UI"}
              </Badge>
            ) : admin.account && admin.chainId !== adminConfig.chainId ? (
              <Button
                className="mt-6"
                variant="brand"
                onClick={() =>
                  admin
                    .ensureNetwork()
                    .catch((error) =>
                      toast.error(error instanceof Error ? error.message : "Network switch failed"),
                    )
                }
              >
                Switch to {adminConfig.chainName}
              </Button>
            ) : admin.account ? (
              <Button
                className="mt-6"
                variant="brand"
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
                variant="brand"
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
