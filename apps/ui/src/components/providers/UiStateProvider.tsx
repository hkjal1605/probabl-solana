"use client";
import { createContext, type ReactNode, useContext, useState } from "react";
import { useStore } from "zustand";
import { createUiStore } from "@/stores/ui-store";

type Store = ReturnType<typeof createUiStore>;
const Context = createContext<Store | null>(null);
export function UiStateProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createUiStore);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
export function useUiStore<T>(selector: (state: ReturnType<Store["getState"]>) => T) {
  const store = useContext(Context);
  if (!store) throw new Error("UI state provider is unavailable");
  return useStore(store, selector);
}
