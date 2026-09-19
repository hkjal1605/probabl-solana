"use client";
import {
  type AtomicPlan,
  claimAddress,
  fundingAsset,
  key,
  type OrderWire,
  orderId,
  parseAtomicPlan,
  parseOrder,
  quote,
} from "@conditional-stocks/solana-client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@/components/providers/WalletProvider";
import { toast } from "@/components/ui/toast";
import { protocolConfig } from "@/config/protocol";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { usePositions } from "@/hooks/useProtocolData";
import {
  announceTradingPermissionChange,
  useTradingPermission,
} from "@/hooks/useTradingPermission";
import { useTradingReadiness } from "@/hooks/useTradingReadiness";
import { marketPriceBound } from "@/lib/trading/entry";
import { createOrder, previewOrder } from "@/lib/trading/order";
import { tradingPermissionApproval } from "@/lib/trading/permission";
import { reviewWithSession } from "@/lib/trading/review-session";
import { solana } from "@/lib/trading/rpc";
import { api } from "@/services/protocol-api-service";
import { refreshStores } from "@/stores/createResourceStore";
import type { MarketView } from "@/types/api";

interface Preparation {
  funding: {
    balanceSufficient: boolean;
    amount: string;
  };
  order: OrderWire;
  orderHash: string;
  notional: string;
  plan: AtomicPlan;
  atomicRouter: string;
}
export function useOrderTicket({ market }: { market: MarketView }) {
  const wallet = useWallet(),
    readiness = useTradingReadiness(market),
    positions = usePositions(),
    {
      permission,
      loaded: permissionLoaded,
      error: permissionError,
      refresh: refreshPermission,
    } = useTradingPermission();
  const [branch, setBranch] = useState<"YES" | "NO">("YES"),
    [side, setSide] = useState<"buy" | "sell">("buy"),
    [tif, setTif] = useState<"gtc" | "ioc">("ioc"),
    [funding, setFunding] = useState<"whole" | "claim">("whole");
  const initialMarketPrice = () => {
    try {
      return marketPriceBound(market, "YES", "buy");
    } catch {
      return "";
    }
  };
  const [quantity, setQuantity] = useState(""),
    [maxFeeBps, setMaxFeeBps] = useState("0"),
    [price, setPrice] = useState(initialMarketPrice);
  // Only user-controlled/signed inputs belong to the action identity. Indexed
  // position blocks advance in the background while a submission is in flight;
  // treating those updates as an action change used to cancel valid orders.
  const actionContext = [
    wallet.account,
    market.id,
    branch,
    side,
    tif,
    funding,
    quantity,
    price,
    maxFeeBps,
    permission?.active,
    permission?.delegate,
    permission?.grant?.expiresAt,
  ].join(":");
  // Balance snapshots still invalidate an idle review so funding sufficiency is
  // recalculated, but they must not invalidate an already-started submission.
  const reviewContext = [actionContext, positions.data?.blockNumber].join(":");
  const revision = useRef({ context: reviewContext, version: 0 });
  if (revision.current.context !== reviewContext)
    revision.current = { context: reviewContext, version: revision.current.version + 1 };
  const [review, setReview] = useState<{
    actionContext: string;
    reviewContext: string;
    value: Preparation;
  } | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewNonce, setReviewNonce] = useState(0);
  const [completedContext, setCompletedContext] = useState<string | null>(null);
  const [submissionCount, setSubmissionCount] = useState(0);
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  const { busy, run } = useAsyncAction(actionContext);
  const preparation =
    review?.actionContext === actionContext && (busy || review.reviewContext === reviewContext)
      ? review.value
      : null;
  const setPreparation = (value: Preparation | null) =>
    setReview(value ? { actionContext, reviewContext, value } : null);
  const { busy: permissionBusy, run: runPermissionAction } = useAsyncAction(
    [wallet.account, permission?.delegate].join(":"),
  );
  useEffect(() => {
    if (!preparation) return;
    const timer = setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, [preparation]);
  const quoteExpired = preparation
    ? BigInt(preparation.plan.deadline) <= BigInt(nowSeconds)
    : false;
  const preview = useMemo(() => previewOrder(quantity, price, market), [quantity, price, market]);
  const prepareAction = async (assertCurrent: () => void, background = false) => {
    if (
      !wallet.account ||
      !preview.valid ||
      !permission?.active ||
      !permission.delegate ||
      !permission.grant
    )
      throw new Error("Deposit assets and enable trading in Portfolio before placing an order.");
    assertCurrent();
    const candidate = parseOrder(
      createOrder({
        ...market,
        account: wallet.account,
        delegate: permission.delegate,
        delegateExpiresAt: permission.grant.expiresAt,
        branch,
        cutoff: market.cutoff,
        funding,
        marketId: market.id,
        maxFeeBps: Number(maxFeeBps),
        price,
        quantity,
        side,
        tif,
      }),
    );
    const result = background
      ? await api.prepare<Omit<Preparation, "funding">>("orders/prepare", { order: candidate })
      : await reviewWithSession({
          token: wallet.sessionToken,
          request: (token) =>
            api.prepare<Omit<Preparation, "funding">>(
              "orders/prepare",
              { order: candidate },
              token,
            ),
          authenticate: wallet.authenticate,
          assertCurrent,
        });
    const asset = fundingAsset(candidate),
      mint =
        asset < 2
          ? asset === 0
            ? market.baseToken
            : market.quoteToken
          : String(claimAddress(key(market.id), asset, key(protocolConfig.programId))),
      balance =
        positions.data?.owner === wallet.account ? positions.data.balances[mint] : undefined,
      available =
        asset < 2
          ? BigInt(balance?.vaultAvailable ?? "0")
          : BigInt(balance?.creditBalances?.[market.id] ?? "0"),
      required =
        candidate.side === 0
          ? quote(BigInt(candidate.quantity), BigInt(candidate.limitPriceRawX18), true)
          : BigInt(candidate.quantity);
    parseAtomicPlan(result.plan, candidate);
    assertCurrent();
    if (result.orderHash !== orderId(candidate) || result.atomicRouter !== protocolConfig.programId)
      throw new Error("API order identity differs.");
    if (BigInt(result.plan.deadline) <= BigInt(Math.floor(Date.now() / 1000)))
      throw new Error("The returned quote has already expired. Retry review.");
    const next = {
      ...result,
      funding: {
        balanceSufficient: positions.isDataFresh && available >= required,
        amount: String(required),
      },
      order: candidate,
    };
    setNowSeconds(Math.floor(Date.now() / 1000));
    setPreparation(next);
    return next;
  };
  const latestPrepare = useRef(prepareAction);
  latestPrepare.current = prepareAction;
  const canReview = Boolean(
    wallet.account &&
      preview.valid &&
      readiness.ready &&
      positions.isDataFresh &&
      Boolean(permission?.active) &&
      market.lifecycle === "open" &&
      completedContext !== actionContext,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: Signed input identity and explicit refresh restart the debounce; streamed market objects do not.
  useEffect(() => {
    let active = true;
    const version = revision.current.version;
    // Freeze the reviewed order once submission begins. Background SSE/indexer
    // updates may refresh balances, but the API and program remain authoritative
    // for the submitted order and will reject insufficient funds atomically.
    if (busy) return;
    setReview(null);
    setReviewError(null);
    setReviewing(canReview);
    if (!canReview) return;
    const assertCurrent = () => {
      if (!active || revision.current.version !== version) throw new Error("Order inputs changed.");
    };
    const timer = setTimeout(async () => {
      try {
        assertCurrent();
        await latestPrepare.current(assertCurrent, true);
      } catch (error) {
        if (active && revision.current.version === version)
          setReviewError(error instanceof Error ? error.message : "Order review failed.");
      } finally {
        if (active && revision.current.version === version) setReviewing(false);
      }
    }, 500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [reviewContext, canReview, reviewNonce, busy]);
  useEffect(() => {
    if (!preparation || busy) return;
    const remaining = Number(preparation.plan.deadline) * 1000 - Date.now();
    // Refresh at most every 30s, earlier for short-lived quotes. Never replace
    // the reviewed plan while a funding/signing action is in progress.
    const delay = Math.max(
      500,
      Math.min(30_000, remaining > 10_000 ? remaining - 5_000 : remaining / 2),
    );
    const refresh = () => {
      if (document.visibilityState !== "hidden") setReviewNonce((value) => value + 1);
    };
    const resume = () => {
      if (document.visibilityState !== "hidden" && Date.now() >= refreshAt) refresh();
    };
    const refreshAt = Date.now() + delay;
    const timer = setTimeout(refresh, delay);
    document.addEventListener("visibilitychange", resume);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [preparation, busy]);
  const prepare = () =>
    run(async (assertCurrent) => {
      const version = revision.current.version;
      const assertReviewCurrent = () => {
        assertCurrent();
        if (revision.current.version !== version)
          throw new Error("Order inputs or balances changed. Review the action again.");
      };
      setReviewError(null);
      setPreparation(null);
      await prepareAction(assertReviewCurrent);
    });
  const submitPreparation = async (current: Preparation, assertCurrent: () => void) => {
    if (!wallet.account || !readiness.ready || !permission?.active)
      throw new Error("Review a currently tradable order first.");
    await readiness.requireReady();
    assertCurrent();
    if (
      current.order.maker !== wallet.account ||
      BigInt(current.plan.deadline) <= BigInt(Math.floor(Date.now() / 1000))
    )
      throw new Error("Wallet changed or quote expired.");
    if (!current.funding.balanceSufficient)
      throw new Error("Deposit the required balance in Portfolio");
    const token = wallet.sessionToken ?? (await wallet.authenticate());
    assertCurrent();
    const response = await api.prepare<{ signature: string; orderHash: string }>(
      "trading/submit",
      { order: current.order },
      token,
    );
    if (
      response.orderHash !== orderId(current.order, key(protocolConfig.programId)) ||
      !response.signature
    )
      throw new Error("Submitted order identity differs from the reviewed order");
    assertCurrent();
    toast.add({
      type: "success",
      title:
        "Order confirmed: " +
        response.signature.slice(0, 10) +
        "… Vault balances update after indexing.",
    });
    setCompletedContext(actionContext);
    setPreparation(null);
    setQuantity("");
    setTif("ioc");
    try {
      setPrice(marketPriceBound(market, branch, side));
    } catch {
      setPrice("");
    }
    setSubmissionCount((value) => value + 1);
    void refreshStores(["positions", "wallet-orders", "payout-credits"]);
    void refreshPermission();
  };
  const submit = () =>
    run(async (assertCurrent) => {
      if (!preparation) throw new Error("Review a currently tradable order first.");
      await submitPreparation(preparation, assertCurrent);
    });
  const enableTrading = () =>
    runPermissionAction(async (assertCurrent) => {
      if (!wallet.account) throw new Error("Connect a wallet to enable trading");
      const current = await refreshPermission();
      assertCurrent();
      if (!current) throw new Error(permissionError ?? "Trading permission is unavailable");
      await wallet.ensureNetwork();
      assertCurrent();
      const client = solana();
      const transaction = tradingPermissionApproval({
        client,
        owner: wallet.account,
        permission: current,
      });
      const signature = await wallet.sendTransaction(transaction);
      toast.add({
        type: "success",
        title: `Trading permission confirmed · ${signature.slice(0, 10)}…`,
      });
      for (let attempt = 0; attempt < 20; attempt++) {
        assertCurrent();
        const refreshed = await refreshPermission();
        if (refreshed?.active) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      announceTradingPermissionChange();
    });
  return {
    wallet,
    permission,
    permissionLoaded,
    permissionError,
    readiness,
    branch,
    setBranch,
    side,
    setSide,
    tif,
    setTif,
    funding,
    setFunding,
    quantity,
    setQuantity,
    maxFeeBps,
    setMaxFeeBps,
    price,
    setPrice,
    busy: busy || permissionBusy,
    reviewing,
    reviewError,
    submissionCount,
    preparation,
    setPreparation,
    quoteExpired,
    preview,
    prepare,
    enableTrading,
    submit,
  };
}
