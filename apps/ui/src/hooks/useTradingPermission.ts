"use client";
import { useCallback, useEffect, useRef } from "react";
import { useStore } from "zustand";
import { useWallet } from "@/components/providers/WalletProvider";
import { fetchTradingPermission } from "@/services/trading-permissions";
import { setTradingPermission, tradingPermissionStore } from "@/stores/useTradingPermissionStore";

export function useTradingPermission() {
  const { account } = useWallet();
  const revision = useRef(0);
  const entry = useStore(tradingPermissionStore, (state) =>
    account ? state.entries[account] : undefined,
  );
  const refresh = useCallback(async () => {
    if (!account) return null;
    const current = ++revision.current;
    try {
      const value = await fetchTradingPermission(account);
      if (revision.current !== current) return null;
      if (
        value.owner !== account ||
        (value.quoteDecimals !== null &&
          (!Number.isInteger(value.quoteDecimals) ||
            value.quoteDecimals < 0 ||
            value.quoteDecimals > 18))
      )
        throw new Error("Invalid trading permission response");
      setTradingPermission(account, value, null);
      return value;
    } catch (error) {
      if (revision.current === current)
        setTradingPermission(
          account,
          null,
          error instanceof Error ? error.message : "Permission unavailable",
        );
      return null;
    }
  }, [account]);
  useEffect(() => {
    if (!account) return;
    void refresh();
    const changed = () => void refresh();
    window.addEventListener("probabl:trading-permission", changed);
    return () => {
      revision.current++;
      window.removeEventListener("probabl:trading-permission", changed);
    };
  }, [account, refresh]);
  return {
    permission: entry?.value ?? null,
    loaded: entry?.loaded ?? false,
    error: entry?.error ?? null,
    refresh,
  };
}
export const announceTradingPermissionChange = () => {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("probabl:trading-permission"));
};
