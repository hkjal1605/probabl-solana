"use client";

import { formatTokenAmount, parseTokenAmount } from "@conditional-stocks/domain";
import {
  claimAddress,
  claimAsset,
  envelope,
  key,
  type SolanaClient,
  underlyingAsset,
  verifyEnvelope,
} from "@conditional-stocks/solana-client";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
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
import { usePositions } from "@/hooks/useProtocolData";
import { assetMint, legStatus } from "@/lib/markets/legs";
import { readClaimMarket, solana, transactionReceipt } from "@/lib/trading/rpc";
import { api } from "@/services/protocol-api-service";
import { refreshStores } from "@/stores/createResourceStore";
import type { MarketView, PositionView } from "@/types/api";

type RecoveryTransaction = Awaited<ReturnType<SolanaClient["redemptionTransaction"]>>;

export function PositionActions({
  position,
  market,
  collateral: initialCollateral,
  disabled = false,
}: {
  position: PositionView;
  market: MarketView;
  /** Initially selected collateral: 0 = quote claims, 1..=3 = an issuer leg's claims. */
  collateral?: number;
  disabled?: boolean;
}) {
  const wallet = useWallet();
  const walletData = usePositions();
  const [open, setOpen] = useState(false),
    [kind, setKind] = useState<"Deposit" | "Split" | "Merge" | "Redeem">(
      position.redeemable ? "Redeem" : "Merge",
    );
  // Claims are segregated per issuer: every action works on one collateral.
  const options = [
    { collateral: 0, label: market.quoteTokenMetadata?.symbol ?? "USDC" },
    ...market.bases.map((leg) => ({ collateral: leg.collateral, label: leg.symbol })),
  ];
  const held = (c: number) =>
    c === 0
      ? BigInt(position.quoteYes) + BigInt(position.quoteNo)
      : position.bases
          .filter((leg) => leg.collateral === c)
          .reduce((sum, leg) => sum + BigInt(leg.yes) + BigInt(leg.no), 0n);
  const [collateral, setCollateral] = useState<number>(
      () =>
        initialCollateral ??
        options.find((option) => option.collateral > 0 && held(option.collateral) > 0n)
          ?.collateral ??
        (held(0) > 0n ? 0 : (options[1]?.collateral ?? 0)),
    ),
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
  const leg = market.bases.find((item) => item.collateral === collateral) ?? null;
  const status = leg ? legStatus(leg) : null;
  const decimals = leg ? leg.decimals : market.quoteTokenDecimals,
    symbol = options.find((option) => option.collateral === collateral)?.label ?? "USDC";
  const claimMint = (asset: number) =>
    assetMint(market, asset) ?? String(claimAddress(key(market.id), asset, solana().program));
  const vaultClaim = (asset: number) => {
    const mint = claimMint(asset);
    return BigInt(
      walletData.data?.owner === wallet.account
        ? (walletData.data.balances[mint]?.creditBalances?.[market.id] ?? "0")
        : "0",
    );
  };
  const externalClaim = (asset: number) => {
    const mint = claimMint(asset);
    return BigInt(
      walletData.data?.owner === wallet.account
        ? (walletData.data.balances[mint]?.canonicalBalance ?? "0")
        : "0",
    );
  };
  const yes = vaultClaim(claimAsset(collateral, 0)),
    no = vaultClaim(claimAsset(collateral, 1));
  const wholeMint = assetMint(market, underlyingAsset(collateral)) ?? market.quoteToken;
  const wholeAvailable = BigInt(
    walletData.data?.owner === wallet.account
      ? (walletData.data.balances[wholeMint]?.vaultAvailable ?? "0")
      : "0",
  );
  const available =
    kind === "Merge"
      ? yes < no
        ? yes
        : no
      : kind === "Deposit"
        ? externalClaim(claimAsset(collateral, branch === "YES" ? 0 : 1))
        : branch === "YES"
          ? yes
          : no;
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
    walletData.isDataFresh &&
    (allClaims
      ? yes + no > 0n
      : raw > 0n &&
        raw < 1n << 64n &&
        (kind === "Split"
          ? market.lifecycle === "open" && (!status || status.tradable) && raw <= wholeAvailable
          : kind === "Deposit"
            ? branch !== "All" && raw <= available
            : raw <= available)) &&
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
        collateral,
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
          : kind === "Deposit"
            ? await (async () => {
                const asset = claimAsset(collateral, branch === "YES" ? 0 : 1);
                const client = solana(),
                  owner = key(wallet.account!),
                  marketKey = key(market.id),
                  mint = claimAddress(marketKey, asset, client.program);
                const token = wallet.sessionToken ?? (await wallet.authenticate());
                assertCurrent();
                const prepared = await api.prepare<{ transaction: ReturnType<typeof envelope> }>(
                  "vault/deposit/prepare",
                  {
                    scope: "market",
                    marketId: market.id,
                    asset: String(mint),
                    tokenId: String(asset),
                    amount: String(raw),
                  },
                  token,
                );
                const deposit = client.deposit(
                  marketKey,
                  owner,
                  mint,
                  asset,
                  raw,
                  TOKEN_PROGRAM_ID,
                );
                const direct = envelope([deposit], client.program);
                const initialized = envelope(
                  [client.initializeWallet(marketKey, owner), deposit],
                  client.program,
                );
                try {
                  verifyEnvelope(direct, prepared);
                } catch {
                  verifyEnvelope(initialized, prepared);
                }
                return prepared.transaction;
              })()
            : kind === "Split"
              ? (() => {
                  const client = solana();
                  client.rememberMarket(key(market.id), canonical);
                  // Split consumes pool credit; the idempotent credit initializer must precede it.
                  return envelope(
                    [
                      client.positionCredit(key(market.id), key(wallet.account!), collateral),
                      client.position(
                        "split",
                        key(market.id),
                        key(wallet.account!),
                        collateral,
                        raw,
                      ),
                    ],
                    client.program,
                  );
                })()
              : await solana().positionTransaction(
                  "merge",
                  key(market.id),
                  key(wallet.account),
                  collateral,
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
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="border-0 bg-primary/10 px-3 text-primary hover:bg-primary/10 hover:text-primary"
            disabled={disabled}
          />
        }
      >
        <Combine />
        {position.redeemable ? "Redeem" : "Manage"}
      </DialogTrigger>
      <DialogContent
        showCloseButton={!busy}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[400px]"
      >
        <DialogHeader>
          <DialogTitle>Manage conditional claims</DialogTitle>
          <DialogDescription>
            {market.ticker} · {market.question}
          </DialogDescription>
        </DialogHeader>
        <FieldSet disabled={busy} className="flex flex-col gap-3">
          <FieldGroup>
            <Segmented
              disabled={busy}
              label="Claim action"
              value={kind}
              options={["Deposit", "Split", "Merge", "Redeem"]}
              onChange={(value) =>
                edit(() => {
                  setKind(value);
                  if (value === "Deposit") setBranch("YES");
                })
              }
              className="w-full"
            />
            <Segmented
              disabled={busy}
              label="Claim collateral"
              value={symbol}
              options={options.map((option) => option.label)}
              onChange={(value) =>
                edit(() =>
                  setCollateral(
                    options.find((option) => option.label === value)?.collateral ?? collateral,
                  ),
                )
              }
              className="w-full"
            />
            {kind === "Split" && status && !status.tradable && (
              <p role="status" className="text-sm text-warning">
                {symbol} cannot be split: {status.reason}.
              </p>
            )}
            <p className="text-sm font-semibold leading-6 text-muted-foreground">
              {kind === "Deposit"
                ? `Move external ${symbol}-${branch} claims into this market vault before trading or redeeming them. Available in wallet: ${formatTokenAmount(available, decimals)} ${symbol}.`
                : kind === "Split"
                  ? `1 deposited ${symbol} → 1 YES + 1 NO claim. Available in vault: ${formatTokenAmount(wholeAvailable, decimals)} ${symbol}.`
                  : kind === "Merge"
                    ? `1 YES + 1 NO claim → 1 whole ${symbol}.`
                    : "Recover matching YES/NO pairs first, then redeem the excess at the finalized payout. INVALID recovery keeps any unmatched raw claim instead of rounding away its value. Losing claims pay zero."}
            </p>
            {(kind === "Redeem" || kind === "Deposit") && (
              <Segmented
                disabled={busy}
                label={kind === "Deposit" ? "Deposit branch" : "Redeem branch"}
                value={branch}
                options={kind === "Deposit" ? ["YES", "NO"] : ["All", "YES", "NO"]}
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
      </DialogContent>
    </Dialog>
  );
}
