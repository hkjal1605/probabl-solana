"use client";

import { formatTokenAmount } from "@conditional-stocks/domain";
import { NATIVE_MINT } from "@solana/spl-token";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useVaultTransfer } from "@/hooks/useVaultTransfer";
import type { assetsForMarkets, useWalletAssets } from "@/hooks/useWalletAssets";

type Asset = ReturnType<typeof assetsForMarkets>[number];
type Balance = ReturnType<typeof useWalletAssets>["balances"][number];

export function PortfolioVault({
  assets,
  balances,
  fresh,
  refresh,
}: {
  assets: Asset[];
  balances: Balance[];
  fresh: boolean;
  refresh: () => Promise<unknown>;
}) {
  const [selected, setSelected] = useState<{
    asset: Asset;
    action: "deposit" | "withdraw";
  } | null>(null);
  const [amount, setAmount] = useState("");
  const open = (asset: Asset, action: "deposit" | "withdraw") => {
    setAmount("");
    setSelected({ asset, action });
  };
  const transfer = useVaultTransfer({
    selection: selected,
    amount,
    balances,
    fresh,
    refresh,
    loadNativeBalance: assets.some((asset) => asset.token === String(NATIVE_MINT)),
    onSuccess: () => {
      setSelected(null);
      setAmount("");
    },
  });
  const chosen = selected && balances.find((row) => row.token === selected.asset.token);
  return (
    <Card className="rounded-xl bg-card">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Trading vault</CardTitle>
        <span className="text-sm text-muted-foreground">
          Deposited funds are available across markets
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {!fresh && balances.length === 0 ? (
          <Skeleton className="h-20 w-full" aria-label="Loading vault balances" />
        ) : assets.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Assets appear here when a market is available.
          </p>
        ) : (
          assets.map((asset) => {
            const row = balances.find((value) => value.token === asset.token);
            const b = row?.balance;
            return (
              <div key={asset.token} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2">
                <div className="min-w-20 font-medium">{asset.symbol}</div>
                <div className="grid flex-1 grid-cols-3 gap-3 tabular-nums">
                  <div>
                    <p className="text-xs text-muted-foreground">Available</p>
                    <p>{b ? formatTokenAmount(BigInt(b.vaultAvailable), asset.decimals) : "—"}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">In orders</p>
                    <p>{b ? formatTokenAmount(BigInt(b.reserved), asset.decimals) : "—"}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Wallet</p>
                    <p>
                      {b
                        ? formatTokenAmount(
                            BigInt(b.canonicalBalance) +
                              (asset.token === String(NATIVE_MINT)
                                ? (transfer.nativeLamports ?? 0n)
                                : 0n),
                            asset.decimals,
                          )
                        : "—"}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!fresh || !b}
                    onClick={() => open(asset, "deposit")}
                  >
                    Deposit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!fresh || !b || BigInt(b.vaultAvailable) === 0n}
                    onClick={() => open(asset, "withdraw")}
                  >
                    Withdraw
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </CardContent>
      <Dialog
        open={selected !== null}
        onOpenChange={(value, details) => {
          if (transfer.busy) details.cancel();
          else if (!value) setSelected(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {selected?.action === "deposit" ? "Deposit to vault" : "Withdraw from vault"}
            </DialogTitle>
            <DialogDescription>
              {selected?.asset.symbol} ·{" "}
              {selected?.action === "deposit"
                ? "Deposit once, then use the balance in any supported market."
                : "Only funds not reserved by open orders can be withdrawn."}
            </DialogDescription>
          </DialogHeader>
          <FieldSet disabled={transfer.busy}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="vault-amount">Amount ({selected?.asset.symbol})</FieldLabel>
                <Input
                  id="vault-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="0"
                />
              </Field>
              <Button
                size="sm"
                variant="link"
                className="self-start"
                disabled={!chosen || !fresh}
                onClick={() => setAmount(chosen ? transfer.maxAmount() : "")}
              >
                Max available
              </Button>
            </FieldGroup>
          </FieldSet>
          {selected?.asset.token === String(NATIVE_MINT) && selected.action === "deposit" && (
            <Alert>
              <AlertDescription>
                SOL is wrapped into its token account as part of the deposit. Keep a little SOL for
                transaction fees.
              </AlertDescription>
            </Alert>
          )}
          <Button
            disabled={transfer.busy || !fresh || !transfer.balance || !amount}
            onClick={transfer.submit}
          >
            {transfer.busy ? <Spinner /> : selected?.action === "deposit" ? "Deposit" : "Withdraw"}
          </Button>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
