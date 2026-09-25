"use client";

import { formatTokenAmount } from "@conditional-stocks/domain";
import { envelope, key } from "@conditional-stocks/solana-client";
import { useState } from "react";
import { useWallet } from "@/components/providers/WalletProvider";
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
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import {
  announceTradingPermissionChange,
  useTradingPermission,
} from "@/hooks/useTradingPermission";
import { shortAddress } from "@/lib/format/display";
import { tradingPermissionApproval } from "@/lib/trading/permission";
import { solana } from "@/lib/trading/rpc";

export function TradingPermissionCard() {
  const wallet = useWallet();
  const { permission, loaded, error, refresh } = useTradingPermission();
  const [open, setOpen] = useState(false),
    [perOrder, setPerOrder] = useState("1000"),
    [total, setTotal] = useState("10000");
  const { busy, run } = useAsyncAction(
    [wallet.account, permission?.delegate, perOrder, total].join(":"),
  );
  const grant = permission?.grant;
  const unavailable =
    !permission?.available || !permission.delegate || permission.quoteDecimals === null;
  const exhausted = Boolean(grant && !permission?.active);
  const update = async () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const value = await refresh();
      if (value?.active || value?.grant?.revoked) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    announceTradingPermissionChange();
  };
  const approve = () =>
    run(async (assertCurrent) => {
      if (
        !wallet.account ||
        !permission?.delegate ||
        permission.quoteDecimals === null ||
        !permission.available ||
        grant
      )
        throw new Error("Trading approval is not available");
      await wallet.ensureNetwork();
      assertCurrent();
      const client = solana();
      const transaction = tradingPermissionApproval({
        client,
        owner: wallet.account,
        permission,
        perOrder,
        total,
      });
      assertCurrent();
      const signature = await wallet.sendTransaction(transaction);
      setOpen(false);
      toast.add({
        type: "success",
        title: `Trading permission confirmed · ${signature.slice(0, 10)}…`,
      });
      void update();
    });
  const revoke = () =>
    run(async (assertCurrent) => {
      if (!wallet.account || !permission?.delegate || !grant || grant.revoked)
        throw new Error("No active trading permission to revoke");
      await wallet.ensureNetwork();
      assertCurrent();
      const client = solana();
      const transaction = envelope(
        [client.revokeDelegate(key(wallet.account), key(permission.delegate))],
        client.program,
      );
      const signature = await wallet.sendTransaction(transaction);
      toast.add({
        type: "success",
        title: `Trading permission revoked · ${signature.slice(0, 10)}…`,
      });
      void update();
    });
  return (
    <Card className="rounded-xl bg-card">
      <CardHeader>
        <CardTitle>Trading permission</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!loaded && <p className="text-sm font-medium text-muted-foreground">Checking permission…</p>}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {loaded && !error && (
          <>
            <p className="text-sm font-medium text-muted-foreground">
              {permission?.active
                ? "Orders can use deposited funds without another wallet approval."
                : unavailable
                  ? "Trading permission is not configured for this deployment."
                  : exhausted
                    ? "This approval is expired, revoked or its lifetime limit is used."
                    : "Approve a dedicated trading key once to place orders from your deposited balances."}
            </p>
            {permission?.delegate && (
              <p className="text-xs font-medium text-muted-foreground">
                Trading key:{" "}
                <span className="font-mono text-foreground">
                  {shortAddress(permission.delegate)}
                </span>
              </p>
            )}
            {grant && permission && permission.quoteDecimals !== null && (
              <>
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt className="font-medium text-muted-foreground">Remaining lifetime limit</dt>
                    <dd className="tabular-nums">
                      {formatTokenAmount(BigInt(grant.remainingQuote), permission.quoteDecimals)}{" "}
                      USDC
                    </dd>
                  </div>
                  <div>
                    <dt className="font-medium text-muted-foreground">Per order</dt>
                    <dd className="tabular-nums">
                      {formatTokenAmount(BigInt(grant.maxOrderQuote), permission.quoteDecimals)}{" "}
                      USDC
                    </dd>
                  </div>
                  <div>
                    <dt className="font-medium text-muted-foreground">Expires</dt>
                    <dd>{new Date(Number(grant.expiresAt) * 1000).toLocaleDateString()}</dd>
                  </div>
                </dl>
                {!grant.revoked && (
                  <Button size="sm" variant="secondary" disabled={busy} onClick={revoke}>
                    {busy ? <Spinner /> : "Revoke permission"}
                  </Button>
                )}
              </>
            )}
            {!grant && !unavailable && (
              <Button disabled={busy} onClick={() => setOpen(true)}>
                Enable trading
              </Button>
            )}
            {exhausted && (
              <p className="text-xs font-medium text-muted-foreground">
                This on-chain approval cannot be renewed for the same key. A new protocol trading
                key is required. Open orders must be cancelled separately.
              </p>
            )}
          </>
        )}
      </CardContent>
      <Dialog
        open={open}
        onOpenChange={(value, details) => {
          if (busy) details.cancel();
          else setOpen(value);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve trading</DialogTitle>
            <DialogDescription>
              Let the protocol trading key place orders across your markets for up to 90 days. It
              pays network fees and cannot withdraw your vault funds. Its trading-fee cap is 1%.
              Limits are charged when orders are placed and are not restored by cancelling them.
            </DialogDescription>
          </DialogHeader>
          <FieldSet disabled={busy}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="trading-order-limit">Maximum per order (USDC)</FieldLabel>
                <Input
                  id="trading-order-limit"
                  value={perOrder}
                  inputMode="decimal"
                  onChange={(event) => setPerOrder(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="trading-total-limit">
                  Total lifetime order limit (USDC)
                </FieldLabel>
                <Input
                  id="trading-total-limit"
                  value={total}
                  inputMode="decimal"
                  onChange={(event) => setTotal(event.target.value)}
                />
                <FieldDescription>
                  You can revoke this permission at any time. Existing orders remain until
                  cancelled.
                </FieldDescription>
              </Field>
            </FieldGroup>
          </FieldSet>
          <Button disabled={busy || !perOrder || !total} onClick={approve}>
            {busy ? <Spinner /> : "Approve in wallet"}
          </Button>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
