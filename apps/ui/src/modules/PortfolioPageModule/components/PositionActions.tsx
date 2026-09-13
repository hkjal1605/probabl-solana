"use client";
import {
  formatTokenAmount,
  parseTokenAmount,
} from "@conditional-stocks/domain";
import { Button } from "@conditional-stocks/ui-kit/button";
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
import { useQueryClient } from "@tanstack/react-query";
import { Combine, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useWallet } from "@/components/providers/WalletProvider";
import { Segmented } from "@/components/ui/segmented";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import type { MarketView, PositionView } from "@/lib/api/types";
import { key, type SolanaClient } from "@conditional-stocks/solana-client";
import { readClaimMarket, solana, transactionReceipt } from "@/lib/trading/rpc";

type RecoveryTransaction = Awaited<
  ReturnType<SolanaClient["redemptionTransaction"]>
>;

export function PositionActions({
  position,
  market,
}: {
  position: PositionView;
  market: MarketView;
}) {
  const wallet = useWallet(),
    cache = useQueryClient();
  const [open, setOpen] = useState(false),
    [kind, setKind] = useState<"Split" | "Merge" | "Redeem">(
      position.redeemable ? "Redeem" : "Merge",
    );
  const [collateral, setCollateral] = useState<"Stock" | "Cash">("Stock"),
    [branch, setBranch] = useState<"All" | "YES" | "NO">("All"),
    [amount, setAmount] = useState("");
  const [review, setReview] = useState<{
    scope: string;
    transaction?: RecoveryTransaction;
  } | null>(null);
  const scope = [
    wallet.account,
    market.id,
    kind,
    collateral,
    branch,
    amount,
    open,
  ].join(":");
  const { busy, run } = useAsyncAction(scope);
  const reviewed = review?.scope === scope ? review : null;
  const decimals =
      collateral === "Stock"
        ? market.baseTokenDecimals
        : market.quoteTokenDecimals,
    symbol = collateral === "Stock" ? market.ticker : "USDG";
  const yes = BigInt(
      collateral === "Stock" ? position.stockYes : position.quoteYes,
    ),
    no = BigInt(collateral === "Stock" ? position.stockNo : position.quoteNo);
  const available =
    kind === "Merge" ? (yes < no ? yes : no) : branch === "YES" ? yes : no;
  const redeemable = position.redeemable;
  const allClaims = kind === "Redeem" && branch === "All";
  let raw = 0n;
  try {
    raw = parseTokenAmount(amount.trim(), decimals);
  } catch {
    /* Invalid input is not actionable. */
  }
  const valid =
    (allClaims
      ? yes + no > 0n
      : raw > 0n &&
        raw < 1n << 64n &&
        (kind === "Split" ? market.lifecycle === "open" : raw <= available)) &&
    (kind !== "Redeem" || redeemable);
  const edit = (action: () => void) => {
    setReview(null);
    action();
  };
  const prepareReview = () =>
    run(async (assertCurrent) => {
      if (!wallet.account || !valid)
        throw new Error("Choose a valid claim action first.");
      if (kind !== "Redeem") {
        setReview({ scope });
        return;
      }
      await wallet.ensureNetwork();
      const canonical = await readClaimMarket(market);
      assertCurrent();
      if (canonical.conditionId !== position.conditionId)
        throw new Error("Claim market differs from the Solana program.");
      const transaction = await solana().redemptionTransaction(
        key(market.id),
        key(wallet.account),
        collateral === "Stock" ? 0 : 1,
        allClaims ? yes : branch === "YES" ? raw : 0n,
        allClaims ? no : branch === "NO" ? raw : 0n,
      );
      assertCurrent();
      setReview({ scope, transaction });
    });
  const recovery = reviewed?.transaction?.recovery;
  const nothingToBurn = !!recovery && recovery.burnYes + recovery.burnNo === 0n;
  const zeroPayout = !!recovery && !nothingToBurn && recovery.credit === 0n;
  const execute = () =>
    run(async (assertCurrent) => {
      if (!wallet.account || !valid || !reviewed)
        throw new Error("Review a valid claim action first.");
      await wallet.ensureNetwork();
      const canonical = await readClaimMarket(market);
      assertCurrent();
      if (canonical.conditionId !== position.conditionId)
        throw new Error("Claim market differs from the Solana program.");
      if (
        kind === "Redeem" &&
        (!reviewed.transaction ||
          nothingToBurn ||
          ![6, 7].includes(canonical.state) ||
          canonical.payouts.some(
            (p, i) => p !== reviewed.transaction!.payouts[i],
          ))
      )
        throw new Error(
          "Redemption changed or has no exact payout; review again.",
        );
      // Sign the locally prepared redemption bytes, not a newly recomputed plan.
      const transaction =
        kind === "Redeem"
          ? reviewed.transaction!
          : await solana().positionTransaction(
              kind === "Split"
                ? "split"
                : kind === "Merge"
                  ? "merge"
                  : "redeem",
              key(market.id),
              key(wallet.account),
              collateral === "Stock" ? 0 : 1,
              raw,
              branch === "YES" ? 0 : 1,
            );
      const approval = false;
      assertCurrent();
      const fees =
        transaction.issuerTransfers?.filter((t) => BigInt(t.fee) > 0n) ?? [];
      if (
        fees.length &&
        !window.confirm(
          "Issuer fees apply to this vault funding:\n" +
            fees
              .map(
                (t) =>
                  `${t.mint}: deposit ${t.gross} raw units, fee ${t.fee}, minimum credit ${t.minimumReceived}`,
              )
              .join("\n") +
            "\nContinue?",
        )
      )
        return;
      const hash = await wallet.sendTransaction(transaction);
      toast.success(
        `${approval ? "Approval" : kind} submitted: ${hash.slice(0, 10)}… Waiting for confirmation.`,
      );
      const receipt = await transactionReceipt(hash);
      assertCurrent();
      if (receipt.status !== "success")
        throw new Error("Transaction reverted. Balances were not changed.");
      await Promise.all(
        ["positions", "whole-balances", "payout-credits"].map((key) =>
          cache.invalidateQueries({ queryKey: [key] }),
        ),
      );
      if (approval)
        toast.success(
          "Approval confirmed. Review the claim action again to continue.",
        );
      else {
        toast.success(
          `${kind} confirmed. Canonical balances update after indexing.`,
        );
        setOpen(false);
        setAmount("");
      }
      setReview(null);
    });
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) {
          setOpen(value);
          setReview(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Combine />
          {position.redeemable ? "Redeem" : "Manage"}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Manage conditional claims</DialogTitle>
          <DialogDescription>
            {market.ticker} · {market.question}
          </DialogDescription>
        </DialogHeader>
        <fieldset disabled={busy} className="space-y-5">
          <Segmented
            label="Claim action"
            value={kind}
            options={["Split", "Merge", "Redeem"]}
            onChange={(value) => edit(() => setKind(value))}
            className="w-full"
          />
          <Segmented
            label="Claim collateral"
            value={collateral}
            options={["Stock", "Cash"]}
            onChange={(value) => edit(() => setCollateral(value))}
            className="w-full"
          />
          <p className="text-sm font-medium leading-6 text-muted-foreground">
            {kind === "Split"
              ? `1 whole ${symbol} → 1 YES + 1 NO claim. Your wallet authorizes exact funding.`
              : kind === "Merge"
                ? `1 YES + 1 NO claim → 1 whole ${symbol}.`
                : "Recover matching YES/NO pairs first, then redeem the excess at the finalized payout. INVALID recovery keeps any unmatched raw claim instead of rounding away its value. Losing claims pay zero."}
          </p>
          {kind === "Redeem" && (
            <Segmented
              label="Redeem branch"
              value={branch}
              options={["All", "YES", "NO"]}
              onChange={(value) => edit(() => setBranch(value))}
            />
          )}
          {allClaims ? (
            <div className="rounded-lg border bg-secondary p-4 text-sm leading-6">
              Available: {formatTokenAmount(yes, decimals)} YES and{" "}
              {formatTokenAmount(no, decimals)} NO claims. Review will show the
              exact payout, quantities burned and any retained claim.
            </div>
          ) : (
            <div>
              <div className="flex items-center justify-between">
                <Label htmlFor="claim-amount">Amount ({symbol})</Label>
                {kind !== "Split" && (
                  <Button
                    size="sm"
                    variant="link"
                    onClick={() =>
                      edit(() =>
                        setAmount(formatTokenAmount(available, decimals)),
                      )
                    }
                  >
                    Max · {formatTokenAmount(available, decimals)}
                  </Button>
                )}
              </div>
              <Input
                id="claim-amount"
                className="mt-2 h-12 font-mono text-lg"
                inputMode="decimal"
                value={amount}
                onChange={(e) => edit(() => setAmount(e.target.value))}
                placeholder="0.00"
              />
            </div>
          )}
          {kind === "Redeem" && !redeemable && (
            <p role="status" className="text-sm text-warning">
              Redemption is not yet enabled for this market.
            </p>
          )}
          {recovery ? (
            <div
              className="rounded-lg border bg-secondary p-4 text-sm leading-6"
              aria-label="Exact redemption review"
            >
              <p>
                Merge {formatTokenAmount(recovery.merge, decimals)} complete
                sets; redeem {formatTokenAmount(recovery.redeemYes, decimals)}{" "}
                YES and {formatTokenAmount(recovery.redeemNo, decimals)} NO.
              </p>
              <p>
                Receive {formatTokenAmount(recovery.credit, decimals)} {symbol}{" "}
                credit ({recovery.credit.toString()} raw units).
              </p>
              <p>
                Burn {recovery.burnYes.toString()} YES /{" "}
                {recovery.burnNo.toString()} NO raw claims. Retain{" "}
                {recovery.retainedYes.toString()} YES /{" "}
                {recovery.retainedNo.toString()} NO raw claims.
              </p>
              {nothingToBurn && (
                <p role="status" className="text-warning">
                  Nothing can be redeemed in whole raw units. Keep the claim or
                  combine it with another claim. No tokens will be burned.
                </p>
              )}
              {zeroPayout && (
                <p role="alert" className="text-warning">
                  Zero payout: these losing claims will be permanently burned
                  for no collateral.
                </p>
              )}
              <p>
                Returned credit belongs to your connected wallet. Network gas
                applies; issuer fees may apply when you later withdraw.
              </p>
            </div>
          ) : (
            reviewed && (
              <div className="rounded-lg border bg-secondary p-4 text-sm leading-6">
                Review: {kind} {formatTokenAmount(raw, decimals)} {symbol}
                {kind === "Redeem"
                  ? `-${branch} claims`
                  : kind === "Merge"
                    ? " claim pairs"
                    : ""}
                . Returned assets belong to your connected wallet. Network gas
                applies; confirmed transactions cannot be undone.
              </div>
            )
          )}
          <Button
            variant="brand"
            className="w-full"
            disabled={busy || !valid || nothingToBurn}
            onClick={() => (reviewed ? execute() : prepareReview())}
          >
            {busy && <LoaderCircle className="animate-spin" />}
            {reviewed
              ? zeroPayout
                ? "Confirm zero-payout burn"
                : `Confirm ${kind.toLowerCase()}`
              : `Review ${kind.toLowerCase()}`}
          </Button>
        </fieldset>
        <p className="text-xs leading-5 text-muted-foreground">
          Merge and redemption use the Solana program. Credited assets can be
          withdrawn from Portfolio. Only your wallet can withdraw your credited
          assets.
        </p>
      </DialogContent>
    </Dialog>
  );
}
