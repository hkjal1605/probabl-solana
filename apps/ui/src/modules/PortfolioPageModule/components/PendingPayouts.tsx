"use client";

import {
  formatTokenAmount,
  parseTokenAmount,
} from "@conditional-stocks/domain";
import { Button } from "@conditional-stocks/ui-kit/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@conditional-stocks/ui-kit/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@conditional-stocks/ui-kit/dialog";
import { Input } from "@conditional-stocks/ui-kit/input";
import { Label } from "@conditional-stocks/ui-kit/label";
import { refreshStores } from "@/stores/createResourceStore";
import { payoutsStore } from "@/stores/usePayoutsStore";
import { useResource } from "@/hooks/useResource";
import { fetchPayouts } from "../utils/fetchPayouts";
import { useState } from "react";
import { toast } from "sonner";
import { useWallet } from "@/components/providers/WalletProvider";
import { protocolConfig } from "@/config/protocol";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { api } from "@/services/protocol-api-service";
import type { MarketView, PayoutCreditView } from "@/types/api";
import { shortAddress } from "@/lib/format/display";
import {
  preparePayoutWithdrawal,
  verifyPayoutResponse,
} from "@/lib/trading/payouts";


export function PendingPayouts({ markets }: { markets: MarketView[] }) {
  const wallet = useWallet();
  const credits = useResource(payoutsStore, wallet.account ?? "", (force) => fetchPayouts(wallet.account ?? "", force), !!wallet.account);
  const rows = credits.data?.payouts ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Available vault credits</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Settlement proceeds, refunds and deposited assets remain yours in the
          vault. They can fund another order in this market or be withdrawn.
          Withdraw to this wallet or another receiving address; no protocol
          withdrawal fee applies.
        </p>
        {credits.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {credits.error?.message}
          </p>
        ) : credits.isPending ? (
          <p className="text-sm text-muted-foreground">
            Reading pending payouts…
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No pending payouts.</p>
        ) : (
          rows.map((credit) => {
            const market = markets.find(
              (m) =>
                m.id === credit.marketId ||
                m.baseToken === credit.collateralToken,
            );
            const symbol =
              credit.kind === "quote"
                ? "USDC"
                : (market?.ticker ?? shortAddress(credit.collateralToken));
            return (
              <div
                key={credit.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
              >
                <div>
                  <p className="font-medium">
                    {formatTokenAmount(BigInt(credit.amount), credit.decimals)}{" "}
                    {symbol}
                    {credit.branch ? ` ${credit.branch} claims` : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {credit.branch
                      ? (market?.question ??
                        shortAddress(credit.marketId ?? ""))
                      : "Whole collateral"}{" "}
                    · {credit.confirmation}
                  </p>
                </div>
                <WithdrawPayout credit={credit} symbol={symbol} />
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

function WithdrawPayout({
  credit,
  symbol,
}: {
  credit: PayoutCreditView;
  symbol: string;
}) {
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  const [recipient, setRecipient] = useState(credit.beneficiary);
  const [amount, setAmount] = useState(
    formatTokenAmount(BigInt(credit.amount), credit.decimals),
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
        !window.confirm(
          `Issuer transfer fee: ${formatTokenAmount(reviewed.fee, credit.decimals)} ${symbol}. You will receive at least ${formatTokenAmount(reviewed.received, credit.decimals)} ${symbol}. Continue?`,
        )
      )
        return;
      if (wallet.chainId !== protocolConfig.chainId)
        await wallet.ensureNetwork();
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
      const hash = await wallet.sendTransaction(
        verifyPayoutResponse(reviewed.transaction, result),
      );
      toast.success(
        `Payout withdrawal submitted: ${hash.slice(0, 10)}… Balances update after indexing.`,
      );
      setOpen(false);
      await refreshStores(["payout-credits", "positions"]);
    });
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) {
          setOpen(value);
          setRecipient(credit.beneficiary);
          setAmount(formatTokenAmount(BigInt(credit.amount), credit.decimals));
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Claim payout
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Claim pending payout</DialogTitle>
          <DialogDescription>
            Withdraw your exact {symbol}
            {credit.branch ? ` ${credit.branch} claims` : ""}. Choose another
            receiving address if this wallet rejects the asset. You pay network
            gas.
          </DialogDescription>
        </DialogHeader>
        <Label htmlFor={`payout-amount-${credit.id}`}>Amount ({symbol})</Label>
        <Input
          id={`payout-amount-${credit.id}`}
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          inputMode="decimal"
          disabled={busy}
        />
        <Label htmlFor={`payout-recipient-${credit.id}`}>
          Receiving address
        </Label>
        <Input
          id={`payout-recipient-${credit.id}`}
          value={recipient}
          onChange={(event) => setRecipient(event.target.value)}
          disabled={busy}
        />
        <p className="break-all text-xs text-muted-foreground">
          Asset: {credit.asset}
          {credit.branch ? ` · Token ID: ${credit.tokenId}` : ""}
        </p>
        <Button variant="brand" onClick={submit} disabled={busy}>
          {busy ? "Preparing withdrawal…" : "Confirm withdrawal"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
