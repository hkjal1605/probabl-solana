"use client";

import { formatTokenAmount, parseTokenAmount } from "@conditional-stocks/domain";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Item, ItemContent } from "@/components/ui/item";
import { EmptyState, LoadingState } from "@/components/ui/page";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { protocolConfig } from "@/config/protocol";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useConfirmation } from "@/hooks/useConfirmation";
import { useResource } from "@/hooks/useResource";
import { shortAddress } from "@/lib/format/display";
import { preparePayoutWithdrawal, verifyPayoutResponse } from "@/lib/trading/payouts";
import { api } from "@/services/protocol-api-service";
import { refreshStores } from "@/stores/createResourceStore";
import { payoutsStore } from "@/stores/usePayoutsStore";
import type { MarketView, PayoutCreditView } from "@/types/api";
import { fetchPayouts } from "../utils/fetchPayouts";

export function PendingPayouts({ markets }: { markets: MarketView[] }) {
  const wallet = useWallet();
  const credits = useResource(
    payoutsStore,
    wallet.account ?? "",
    (force) => fetchPayouts(wallet.account ?? "", force),
    !!wallet.account,
  );
  const rows = credits.data?.payouts ?? [];
  return (
    <Card variant="panel" className="border">
      <CardHeader>
        <CardTitle>Available vault credits</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 py-3">
        <p className="text-sm text-muted-foreground">
          Settlement proceeds, refunds and deposited assets remain yours in the vault. They can fund
          another order in this market or be withdrawn. Withdraw to this wallet or another receiving
          address; no protocol withdrawal fee applies.
        </p>
        {credits.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{credits.error?.message}</AlertDescription>
          </Alert>
        ) : credits.isPending ? (
          <LoadingState>Reading pending payouts…</LoadingState>
        ) : rows.length === 0 ? (
          <EmptyState>No pending payouts.</EmptyState>
        ) : (
          rows.map((credit) => {
            const market = markets.find(
              (m) => m.id === credit.marketId || m.baseToken === credit.collateralToken,
            );
            const symbol =
              credit.kind === "quote"
                ? "USDC"
                : (market?.ticker ?? shortAddress(credit.collateralToken));
            return (
              <Item key={credit.id} variant="outline">
                <ItemContent>
                  <div>
                    <p className="font-medium">
                      {formatTokenAmount(BigInt(credit.amount), credit.decimals)} {symbol}
                      {credit.branch ? ` ${credit.branch} claims` : ""}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {credit.branch
                        ? (market?.question ?? shortAddress(credit.marketId ?? ""))
                        : "Whole collateral"}{" "}
                      · {credit.confirmation}
                    </p>
                  </div>
                  <WithdrawPayout credit={credit} symbol={symbol} />
                </ItemContent>
              </Item>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

function WithdrawPayout({ credit, symbol }: { credit: PayoutCreditView; symbol: string }) {
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  const [recipient, setRecipient] = useState(credit.beneficiary);
  const [amount, setAmount] = useState(formatTokenAmount(BigInt(credit.amount), credit.decimals));
  const { confirm, confirmation } = useConfirmation(
    [wallet.account, credit.id, recipient, amount, open].join(":"),
  );
  const { busy, run } = useAsyncAction(
    [wallet.account, credit.id, recipient, amount, open].join(":"),
  );
  const submit = () =>
    run(async (assertCurrent) => {
      if (!wallet.account) return;
      const raw = parseTokenAmount(amount.trim(), credit.decimals);
      const reviewed = await preparePayoutWithdrawal({
        credit,
        amount: raw,
        recipient: recipient.trim(),
        account: wallet.account,
        config: protocolConfig,
      });
      assertCurrent();
      if (
        reviewed.fee > 0n &&
        !(await confirm(
          `Issuer transfer fee: ${formatTokenAmount(reviewed.fee, credit.decimals)} ${symbol}. You will receive at least ${formatTokenAmount(reviewed.received, credit.decimals)} ${symbol}. Continue?`,
        ))
      )
        return;
      assertCurrent();
      if (wallet.chainId !== protocolConfig.chainId) await wallet.ensureNetwork();
      const token = wallet.sessionToken ?? (await wallet.authenticate());
      const result = await api.prepare<unknown>(
        "payouts/withdraw/prepare",
        {
          marketId: credit.marketId,
          asset: credit.asset,
          tokenId: credit.tokenId,
          amount: String(raw),
          recipient: recipient.trim(),
        },
        token,
      );
      assertCurrent();
      const hash = await wallet.sendTransaction(verifyPayoutResponse(reviewed.transaction, result));
      toast.add({
        type: "success",
        title: `Payout withdrawal submitted: ${hash.slice(0, 10)}… Balances update after indexing.`,
      });
      setOpen(false);
      await refreshStores(["payout-credits", "positions"]);
    });
  return (
    <Dialog
      open={open}
      onOpenChange={(value, details) => {
        if (busy) details.cancel();
        if (!busy) {
          setOpen(value);
          setRecipient(credit.beneficiary);
          setAmount(formatTokenAmount(BigInt(credit.amount), credit.decimals));
        }
      }}
    >
      {confirmation}
      <DialogTrigger render={<Button variant="outline" size="sm" />}>Claim payout</DialogTrigger>
      <DialogContent
        showCloseButton={!busy}
        className="max-h-[90dvh] overflow-y-auto sm:max-w-[400px]"
      >
        <DialogHeader>
          <DialogTitle>Claim pending payout</DialogTitle>
          <DialogDescription>
            Withdraw your exact {symbol}
            {credit.branch ? ` ${credit.branch} claims` : ""}. Choose another receiving address if
            this wallet rejects the asset. You pay network gas.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field data-disabled={busy}>
            <FieldLabel htmlFor={`payout-amount-${credit.id}`}>Amount ({symbol})</FieldLabel>
            <Input
              id={`payout-amount-${credit.id}`}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="decimal"
              disabled={busy}
            />
          </Field>
          <Field data-disabled={busy}>
            <FieldLabel htmlFor={`payout-recipient-${credit.id}`}>Receiving address</FieldLabel>
            <Input
              id={`payout-recipient-${credit.id}`}
              value={recipient}
              onChange={(event) => setRecipient(event.target.value)}
              disabled={busy}
            />
          </Field>
        </FieldGroup>
        <p className="break-all text-xs text-muted-foreground">
          Asset: {credit.asset}
          {credit.branch ? ` · Token ID: ${credit.tokenId}` : ""}
        </p>
        <Button variant="default" onClick={submit} disabled={busy}>
          {busy && <Spinner data-icon="inline-start" />}
          {busy ? "Preparing withdrawal…" : "Confirm withdrawal"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
