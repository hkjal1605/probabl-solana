"use client";
import {
  parseOrder,
  parseAtomicPlan,
  orderId,
  verifyEnvelope,
  type AtomicPlan,
  type OrderWire,
} from "@conditional-stocks/solana-client";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useWallet } from "@/components/providers/WalletProvider";
import { protocolConfig } from "@/config/protocol";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useTradingReadiness } from "@/hooks/useTradingReadiness";
import { api } from "@/lib/api/client";
import type { MarketView } from "@/lib/api/types";
import { createOrder, previewOrder } from "@/lib/trading/order";
import { solana } from "@/lib/trading/rpc";
import { atomicTransaction, verifyAtomicResponse } from "@/lib/trading/atomic";
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
    [tif, setTif] = useState<"gtc" | "ioc">("gtc"),
    [funding, setFunding] = useState<"whole" | "claim">("whole");
  const book = branch === "YES" ? market.yes : market.no,
    defaultPrice = side === "buy" ? book.bestAskExact : book.bestBidExact;
  const [quantity, setQuantity] = useState("1"),
    [maxFeeBps, setMaxFeeBps] = useState("0"),
    [price, setPrice] = useState(defaultPrice ?? "");
  const [preparation, setPreparation] = useState<Preparation | null>(null),
    [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  const { busy, run } = useAsyncAction(
    [wallet.account, market.id, branch, side, tif, funding, quantity, price, maxFeeBps].join(":"),
  );
  useEffect(() => {
    setPreparation(null);
  }, [wallet.account, market.id, branch, side, tif, funding, quantity, price, maxFeeBps]);
  useEffect(() => {
    if (!preparation) return;
    const timer = setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, [preparation]);
  const quoteExpired = preparation
    ? BigInt(preparation.plan.deadline) <= BigInt(nowSeconds)
    : false;
  const preview = useMemo(() => previewOrder(quantity, price, market), [quantity, price, market]);
  const prepare = () =>
    run(async (assertCurrent) => {
      setPreparation(null);
      await readiness.requireReady();
      assertCurrent();
      if (!wallet.account || !preview.valid)
        throw new Error("Connect your wallet and enter a valid quantity and price.");
      await wallet.ensureNetwork();
      const token = wallet.sessionToken ?? (await wallet.authenticate());
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
      const result = await api.prepare<Preparation>("orders/prepare", { order: candidate }, token);
      const localFunding = await solana().funding(candidate);
      if (localFunding.approvalCall)
        verifyEnvelope(localFunding.approvalCall, {
          transaction: result.funding.approvalCall,
        });
      else if (result.funding.approvalCall)
        throw new Error("API funding differs from local balances");
      parseAtomicPlan(result.plan, candidate);
      assertCurrent();
      if (
        result.orderHash !== orderId(candidate) ||
        result.atomicRouter !== protocolConfig.programId
      )
        throw new Error("API order identity differs.");
      setNowSeconds(Math.floor(Date.now() / 1000));
      setPreparation({ ...result, funding: localFunding, order: candidate });
    });
  const approve = () =>
    run(async (assertCurrent) => {
      if (!preparation?.funding.approvalCall) return;
      await readiness.requireReady();
      assertCurrent();
      const fresh = await solana().funding(preparation.order);
      assertCurrent();
      if (!fresh.approvalCall || !fresh.balanceSufficient)
        throw new Error("Funding changed. Review the order again.");
      verifyEnvelope(fresh.approvalCall, {
        transaction: preparation.funding.approvalCall,
      });
      await wallet.sendTransaction(fresh.approvalCall);
      toast.success("Order funding confirmed. Review the execution quote again.");
      setPreparation(null);
    });
  const submit = () =>
    run(async (assertCurrent) => {
      if (!preparation || !wallet.account || !readiness.ready)
        throw new Error("Review a currently tradable order first.");
      await readiness.requireReady();
      assertCurrent();
      if (
        preparation.order.maker !== wallet.account ||
        BigInt(preparation.plan.deadline) <= BigInt(Math.floor(Date.now() / 1000))
      )
        throw new Error("Wallet changed or quote expired.");
      const expected = atomicTransaction({
        order: preparation.order,
        plan: preparation.plan,
        account: wallet.account,
        config: protocolConfig,
      });
      const token = wallet.sessionToken ?? (await wallet.authenticate());
      assertCurrent();
      const response = await api.prepare<unknown>(
        "orders/transaction",
        { order: preparation.order, plan: preparation.plan },
        token,
      );
      const transaction = verifyAtomicResponse(expected, response);
      assertCurrent();
      const signature = await wallet.sendTransaction(transaction);
      toast.success(
        "Order confirmed: " +
          signature.slice(0, 10) +
          "… Fills and balances update after indexing.",
      );
      setPreparation(null);
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
    preparation,
    setPreparation,
    quoteExpired,
    preview,
    prepare,
    approve,
    submit,
  };
}
