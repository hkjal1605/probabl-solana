"use client";

import { formatTokenAmount, parseTokenAmount } from "@conditional-stocks/domain";
import { key, type SolanaClient } from "@conditional-stocks/solana-client";
import { Combine } from "lucide-react";
import { useState } from "react";
import { useWallet } from "@/components/providers/WalletProvider";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldSet, FieldLabel as Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useConfirmation } from "@/hooks/useConfirmation";
import { readClaimMarket, solana, transactionReceipt } from "@/lib/trading/rpc";
import { refreshStores } from "@/stores/createResourceStore";
import type { MarketView, PositionView } from "@/types/api";

type RecoveryTransaction = Awaited<ReturnType<SolanaClient["redemptionTransaction"]>>;

export function PositionActions({
  position,
  market,
  disabled = false,
}: {
  position: PositionView;
  market: MarketView;
  disabled?: boolean;
}) {
  const wallet = useWallet();
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
  const scope = [wallet.account, market.id, kind, collateral, branch, amount, open].join(":");
  const { busy, run } = useAsyncAction(scope);
  const { confirm, confirmation } = useConfirmation(scope);
  const reviewed = review?.scope === scope ? review : null;
  const decimals = collateral === "Stock" ? market.baseTokenDecimals : market.quoteTokenDecimals,
    symbol = collateral === "Stock" ? market.ticker : "USDC";
  const yes = BigInt(collateral === "Stock" ? position.stockYes : position.quoteYes),
    no = BigInt(collateral === "Stock" ? position.stockNo : position.quoteNo);
  const available = kind === "Merge" ? (yes < no ? yes : no) : branch === "YES" ? yes : no;
  const redeemable = position.redeemable;
  const allClaims = kind === "Redeem" && branch === "All";
  let raw = 0n;
  try {
    raw = parseTokenAmount(amount.trim(), decimals);
  } catch {
    /* Invalid input is not actionable. */
  }
  const valid =
    !disabled &&
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
      if (!wallet.account || !valid) throw new Error("Choose a valid claim action first.");
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
          canonical.payouts.some((p, i) => p !== reviewed.transaction!.payouts[i]))
      )
        throw new Error("Redemption changed or has no exact payout; review again.");
      // Sign the locally prepared redemption bytes, not a newly recomputed plan.
      const transaction =
        kind === "Redeem"
          ? reviewed.transaction!
          : await solana().positionTransaction(
              kind === "Split" ? "split" : kind === "Merge" ? "merge" : "redeem",
              key(market.id),
              key(wallet.account),
              collateral === "Stock" ? 0 : 1,
              raw,
              branch === "YES" ? 0 : 1,
            );
      const approval = false;
      assertCurrent();
      const fees = transaction.issuerTransfers?.filter((t) => BigInt(t.fee) > 0n) ?? [];
      if (
        fees.length &&
        !(await confirm(
          "Issuer fees apply to this vault funding:\n" +
            fees
              .map(
                (t) =>
                  `${t.mint}: deposit ${t.gross} raw units, fee ${t.fee}, minimum credit ${t.minimumReceived}`,
              )
              .join("\n") +
            "\nContinue?",
        ))
      )
        return;
      assertCurrent();
      const hash = await wallet.sendTransaction(transaction);
      toast.add({
        type: "success",
        title: `${approval ? "Approval" : kind} submitted: ${hash.slice(0, 10)}… Waiting for confirmation.`,
      });
      const receipt = await transactionReceipt(hash);
      assertCurrent();
      if (receipt.status !== "success")
        throw new Error("Transaction reverted. Balances were not changed.");
      await refreshStores(["positions", "payout-credits"]);
      if (approval)
        toast.add({
          type: "success",
          title: "Approval confirmed. Review the claim action again to continue.",
        });
      else {
        toast.add({
          type: "success",
          title: `${kind} confirmed. Canonical balances update after indexing.`,
        });
        setOpen(false);
        setAmount("");
      }
      setReview(null);
    });
  return (
    <Dialog
      open={open}
      onOpenChange={(value, details) => {
        if (busy) details.cancel();
        if (!busy) {
          setOpen(value);
          setReview(null);
        }
      }}
    >
      {confirmation}
      <DialogTrigger render={<Button variant="outline" size="sm" disabled={disabled} />}>
        <Combine />
        {position.redeemable ? "Redeem" : "Manage"}
      </DialogTrigger>
      <DialogContent
        showCloseButton={!busy}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>Manage conditional claims</DialogTitle>
          <DialogDescription>
            {market.ticker} · {market.question}
          </DialogDescription>
        </DialogHeader>
        <FieldSet disabled={busy} className="flex flex-col gap-5">
          <FieldGroup>
            <Segmented
              disabled={busy}
              label="Claim action"
              value={kind}
              options={["Split", "Merge", "Redeem"]}
              onChange={(value) => edit(() => setKind(value))}
              className="w-full"
            />
            <Segmented
              disabled={busy}
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
                disabled={busy}
                label="Redeem branch"
                value={branch}
                options={["All", "YES", "NO"]}
                onChange={(value) => edit(() => setBranch(value))}
              />
            )}
            {allClaims ? (
              <Alert role="status">
                <AlertDescription>
                  Available: {formatTokenAmount(yes, decimals)} YES and{" "}
                  {formatTokenAmount(no, decimals)} NO claims. Review will show the exact payout,
                  quantities burned and any retained claim.
                </AlertDescription>
              </Alert>
            ) : (
              <Field>
                <div className="flex items-center justify-between">
                  <Label htmlFor="claim-amount">Amount ({symbol})</Label>
                  {kind !== "Split" && (
                    <Button
                      size="sm"
                      variant="link"
                      onClick={() => edit(() => setAmount(formatTokenAmount(available, decimals)))}
                    >
                      Max · {formatTokenAmount(available, decimals)}
                    </Button>
                  )}
                </div>
                <Input
                  id="claim-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => edit(() => setAmount(e.target.value))}
                  placeholder="0.00"
                />
              </Field>
            )}
            {kind === "Redeem" && !redeemable && (
              <p role="status" className="text-sm text-warning">
                Redemption is not yet enabled for this market.
              </p>
            )}
            {recovery ? (
              <Alert role="status" aria-label="Exact redemption review">
                <AlertDescription>
                  <p>
                    Merge {formatTokenAmount(recovery.merge, decimals)} complete sets; redeem{" "}
                    {formatTokenAmount(recovery.redeemYes, decimals)} YES and{" "}
                    {formatTokenAmount(recovery.redeemNo, decimals)} NO.
                  </p>
                  <p>
                    Receive {formatTokenAmount(recovery.credit, decimals)} {symbol} credit (
                    {recovery.credit.toString()} raw units).
                  </p>
                  <p>
                    Burn {recovery.burnYes.toString()} YES / {recovery.burnNo.toString()} NO raw
                    claims. Retain {recovery.retainedYes.toString()} YES /{" "}
                    {recovery.retainedNo.toString()} NO raw claims.
                  </p>
                  {nothingToBurn && (
                    <p role="status" className="text-warning">
                      Nothing can be redeemed in whole raw units. Keep the claim or combine it with
                      another claim. No tokens will be burned.
                    </p>
                  )}
                  {zeroPayout && (
                    <Alert>
                      <AlertDescription>
                        Zero payout: these losing claims will be permanently burned for no
                        collateral.
                      </AlertDescription>
                    </Alert>
                  )}
                  <p>
                    Returned credit belongs to your connected wallet. Network gas applies; issuer
                    fees may apply when you later withdraw.
                  </p>
                </AlertDescription>
              </Alert>
            ) : (
              reviewed && (
                <Alert role="status">
                  <AlertDescription>
                    Review: {kind} {formatTokenAmount(raw, decimals)} {symbol}
                    {kind === "Redeem"
                      ? `-${branch} claims`
                      : kind === "Merge"
                        ? " claim pairs"
                        : ""}
                    . Returned assets belong to your connected wallet. Network gas applies;
                    confirmed transactions cannot be undone.
                  </AlertDescription>
                </Alert>
              )
            )}
            <Button
              variant="default"
              className="w-full"
              disabled={busy || !valid || nothingToBurn}
              onClick={() => (reviewed ? execute() : prepareReview())}
            >
              {busy && <Spinner data-icon="inline-start" />}
              {reviewed
                ? zeroPayout
                  ? "Confirm zero-payout burn"
                  : `Confirm ${kind.toLowerCase()}`
                : `Review ${kind.toLowerCase()}`}
            </Button>
          </FieldGroup>
        </FieldSet>
        <p className="text-xs leading-5 text-muted-foreground">
          Merge and redemption use the Solana program. Credited assets can be withdrawn from
          Portfolio. Only your wallet can withdraw your credited assets.
        </p>
      </DialogContent>
    </Dialog>
  );
}
