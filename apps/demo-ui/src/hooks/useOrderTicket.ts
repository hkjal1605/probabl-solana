"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@/components/providers/WalletProvider";
import { toast } from "@/components/ui/toast";
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
import { type OrderIntent, type OrderPlan, reviewOrder, submitOrder } from "@/protocol/engine";
import { refreshStores } from "@/stores/createResourceStore";
import type { MarketView } from "@/types/api";

/** How often a reviewed order is silently re-priced against the current book. */
const REVIEW_REFRESH_MS = 5_000;

interface Preparation {
  funding: { balanceSufficient: boolean; amount: string };
  order: OrderIntent;
  orderHash: string;
  notional: string;
  plan: OrderPlan;
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
  // Only user-controlled, signed inputs belong to the action identity. Indexed
  // balances advance in the background while a submission is in flight.
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
  const revision = useRef({ context: actionContext, version: 0 });
  if (revision.current.context !== actionContext)
    revision.current = { context: actionContext, version: revision.current.version + 1 };
  const [review, setReview] = useState<{ context: string; value: Preparation } | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [completedContext, setCompletedContext] = useState<string | null>(null);
  const [submissionCount, setSubmissionCount] = useState(0);
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  const { busy, run } = useAsyncAction(actionContext);
  const preparation = review?.context === actionContext ? review.value : null;
  const setPreparation = (value: Preparation | null) =>
    setReview(value ? { context: actionContext, value } : null);
  const { busy: permissionBusy, run: runPermissionAction } = useAsyncAction(
    [wallet.account, permission?.delegate].join(":"),
  );
  useEffect(() => {
    if (!preparation) return;
    const timer = setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, [preparation]);
  const quoteExpired = preparation ? Number(preparation.plan.deadline) <= nowSeconds : false;
  const preview = useMemo(() => previewOrder(quantity, price, market), [quantity, price, market]);
  const prepareAction = async (assertCurrent: () => void) => {
    if (!wallet.account || !preview.valid || !permission?.active || !permission.grant)
      throw new Error("Deposit assets and enable trading in Portfolio before placing an order.");
    assertCurrent();
    const candidate = createOrder({
      ...market,
      branch,
      funding,
      marketId: market.id,
      maxFeeBps: Number(maxFeeBps),
      price,
      quantity,
      side,
      tif,
    });
    const plan = reviewOrder(candidate);
    assertCurrent();
    const next: Preparation = {
      funding: {
        balanceSufficient: positions.isDataFresh && plan.balanceSufficient,
        amount: plan.requiredRaw,
      },
      order: candidate,
      orderHash: "",
      notional: plan.notional,
      plan,
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
    // Freeze the reviewed order once submission begins.
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
        await latestPrepare.current(assertCurrent);
      } catch (error) {
        if (active && revision.current.version === version)
          setReviewError(error instanceof Error ? error.message : "Order review failed.");
      } finally {
        if (active && revision.current.version === version) setReviewing(false);
      }
    }, 400);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [actionContext, canReview, busy]);
  // Re-price the reviewed order on a slow cadence so depth and funding stay
  // current. These refreshes replace the plan in place: they never clear the
  // ticket or flash it as loading, which is what a per-block refresh used to do.
  // biome-ignore lint/correctness/useExhaustiveDependencies: The timer captures the current revision, so changed signed inputs must restart it.
  useEffect(() => {
    if (!canReview || busy) return;
    let active = true;
    const version = revision.current.version;
    const refresh = async () => {
      if (!active || document.visibilityState === "hidden") return;
      try {
        await latestPrepare.current(() => {
          if (!active || revision.current.version !== version)
            throw new Error("Order inputs changed.");
        });
        if (active && revision.current.version === version) setReviewError(null);
      } catch (error) {
        // Keep the last reviewed order on screen; it still expires on its own deadline.
        if (active && revision.current.version === version)
          setReviewError(error instanceof Error ? error.message : "Order review failed.");
      }
    };
    const timer = setInterval(refresh, REVIEW_REFRESH_MS);
    const resume = () => void refresh();
    document.addEventListener("visibilitychange", resume);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [actionContext, canReview, busy]);
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
    if (Number(current.plan.deadline) <= Math.floor(Date.now() / 1000))
      throw new Error("Wallet changed or quote expired.");
    if (!current.funding.balanceSufficient)
      throw new Error("Deposit the required balance in Portfolio");
    const response = submitOrder(current.order);
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
      const signature = await wallet.sendTransaction(
        tradingPermissionApproval({ owner: wallet.account, permission: current }),
      );
      toast.add({
        type: "success",
        title: `Trading permission confirmed · ${signature.slice(0, 10)}…`,
      });
      await refreshPermission();
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
