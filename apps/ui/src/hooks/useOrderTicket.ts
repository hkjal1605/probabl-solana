"use client";
import {
  type AtomicPlan,
  type OrderWire,
  orderId,
  parseAtomicPlan,
  parseOrder,
  verifyEnvelope,
} from "@conditional-stocks/solana-client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@/components/providers/WalletProvider";
import { toast } from "@/components/ui/toast";
import { protocolConfig } from "@/config/protocol";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useTradingReadiness } from "@/hooks/useTradingReadiness";
import { atomicTransaction, verifyAtomicResponse } from "@/lib/trading/atomic";
import { marketPriceBound } from "@/lib/trading/entry";
import { createOrder, previewOrder } from "@/lib/trading/order";
import { reviewWithSession } from "@/lib/trading/review-session";
import { solana } from "@/lib/trading/rpc";
import { api } from "@/services/protocol-api-service";
import type { MarketView } from "@/types/api";

interface Preparation {
  funding: {
    approvalCall: { to: string; data: string; value: "0" } | null;
    approved: boolean;
    balanceSufficient: boolean;
    amount: string;
    assetKind: string;
    depositAmount?: string;
    transferFee?: string;
  };
  order: OrderWire;
  orderHash: string;
  notional: string;
  plan: AtomicPlan;
  atomicRouter: string;
}
export function useOrderTicket({ market }: { market: MarketView }) {
  const wallet = useWallet(),
    readiness = useTradingReadiness(market);
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
  const context = [
    wallet.account,
    market.id,
    branch,
    side,
    tif,
    funding,
    quantity,
    price,
    maxFeeBps,
  ].join(":");
  const revision = useRef({ context, version: 0 });
  if (revision.current.context !== context)
    revision.current = { context, version: revision.current.version + 1 };
  const [review, setReview] = useState<{ context: string; value: Preparation } | null>(null);
  const preparation = review?.context === context ? review.value : null;
  const setPreparation = (value: Preparation | null) =>
    setReview(value ? { context, value } : null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewNonce, setReviewNonce] = useState(0);
  const [completedContext, setCompletedContext] = useState<string | null>(null);
  const [submissionCount, setSubmissionCount] = useState(0);
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  const { busy, run } = useAsyncAction(context);
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
    if (!wallet.account || !preview.valid)
      throw new Error("Connect your wallet and enter a valid quantity and price.");
    if (!background) await wallet.ensureNetwork();
    assertCurrent();
    const candidate = parseOrder(
      createOrder({
        ...market,
        account: wallet.account,
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
    const [result, localFunding] = await Promise.all([
      background
        ? api.prepare<Omit<Preparation, "funding">>(
            "orders/prepare",
            { order: candidate },
            wallet.sessionToken ?? undefined,
          )
        : reviewWithSession({
            token: wallet.sessionToken,
            request: (token) =>
              api.prepare<Omit<Preparation, "funding">>(
                "orders/prepare",
                { order: candidate },
                token,
              ),
            authenticate: wallet.authenticate,
            assertCurrent,
          }),
      solana().funding(candidate),
    ]);
    // Funding instructions are built exclusively from locally validated chain
    // accounts. The API supplies only the indexed execution plan, not custody instructions.
    parseAtomicPlan(result.plan, candidate);
    assertCurrent();
    if (result.orderHash !== orderId(candidate) || result.atomicRouter !== protocolConfig.programId)
      throw new Error("API order identity differs.");
    if (BigInt(result.plan.deadline) <= BigInt(Math.floor(Date.now() / 1000)))
      throw new Error("The returned quote has already expired. Retry review.");
    const next = { ...result, funding: localFunding, order: candidate };
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
      market.lifecycle === "open" &&
      completedContext !== context,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: Signed input identity and explicit refresh restart the debounce; streamed market objects do not.
  useEffect(() => {
    let active = true;
    const version = revision.current.version;
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
  }, [context, canReview, reviewNonce]);
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
      setReviewError(null);
      setPreparation(null);
      await prepareAction(assertCurrent);
    });
  const submitPreparation = async (current: Preparation, assertCurrent: () => void) => {
    if (!wallet.account || !readiness.ready)
      throw new Error("Review a currently tradable order first.");
    await readiness.requireReady();
    assertCurrent();
    if (
      current.order.maker !== wallet.account ||
      BigInt(current.plan.deadline) <= BigInt(Math.floor(Date.now() / 1000))
    )
      throw new Error("Wallet changed or quote expired.");
    const expected = atomicTransaction({
      order: current.order,
      plan: current.plan,
      account: wallet.account,
      config: protocolConfig,
    });
    const token = wallet.sessionToken ?? (await wallet.authenticate());
    assertCurrent();
    const response = await api.prepare<unknown>(
      "orders/transaction",
      { order: current.order, plan: current.plan },
      token,
    );
    const transaction = verifyAtomicResponse(expected, response);
    assertCurrent();
    const signature = await wallet.sendTransaction(transaction);
    toast.add({
      type: "success",
      title:
        "Order confirmed: " +
        signature.slice(0, 10) +
        "… Fills and balances update after indexing.",
    });
    setCompletedContext(context);
    setPreparation(null);
    setQuantity("");
    setTif("ioc");
    try {
      setPrice(marketPriceBound(market, branch, side));
    } catch {
      setPrice("");
    }
    setSubmissionCount((value) => value + 1);
  };
  const approve = () =>
    run(async (assertCurrent) => {
      if (!preparation?.funding.approvalCall) return;
      const [, fresh] = await Promise.all([
        readiness.requireReady(),
        solana().funding(preparation.order),
      ]);
      assertCurrent();
      if (!fresh.approvalCall || !fresh.balanceSufficient)
        throw new Error("Funding changed. Review the order again.");
      verifyEnvelope(fresh.approvalCall, {
        transaction: preparation.funding.approvalCall,
      });
      await wallet.sendTransaction(fresh.approvalCall);
      toast.add({
        type: "success",
        title: "Order funding confirmed.",
      });
      setPreparation(null);
      assertCurrent();
      const fundedPreparation = await prepareAction(assertCurrent);
      assertCurrent();
      if (fundedPreparation.funding.approvalCall || !fundedPreparation.funding.balanceSufficient)
        throw new Error("Confirmed funding is not available yet. Retry the order.");
      await submitPreparation(fundedPreparation, assertCurrent);
    });
  const submit = () =>
    run(async (assertCurrent) => {
      if (!preparation) throw new Error("Review a currently tradable order first.");
      await submitPreparation(preparation, assertCurrent);
    });
  return {
    wallet,
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
    busy,
    reviewing,
    reviewError,
    submissionCount,
    preparation,
    setPreparation,
    quoteExpired,
    preview,
    prepare,
    approve,
    submit,
  };
}
