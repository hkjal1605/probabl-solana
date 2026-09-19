import { createStore } from "zustand/vanilla";
import type { TradingPermission } from "@/services/trading-permissions";

interface State {
  entries: Record<string, { value: TradingPermission | null; error: string | null; loaded: boolean }>;
}
export const tradingPermissionStore = createStore<State>(() => ({ entries: {} }));
export function setTradingPermission(owner: string, value: TradingPermission | null, error: string | null) {
  tradingPermissionStore.setState(s => ({
    entries: { ...s.entries, [owner]: { value, error, loaded: true } },
  }));
}
export function clearTradingPermissions() {
  tradingPermissionStore.setState({ entries: {} });
}
