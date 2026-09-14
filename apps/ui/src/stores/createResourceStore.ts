import { createStore } from "zustand/vanilla";

export interface Resource<T> {
  data: T | undefined;
  error: Error | null;
  loading: boolean;
  updatedAt: number;
  revision: number;
  streamUntil?: number;
}
export const emptyResource: Resource<never> = {
  data: undefined,
  error: null,
  loading: false,
  updatedAt: 0,
  revision: 0,
};
export const resources = new Map<string, ReturnType<typeof createResourceStore<any>>>();

/** Domain-owned data, no network calls and no persisted wallet/market snapshots. */
export function createResourceStore<T>(name: string) {
  const store = createStore<{ entries: Record<string, Resource<T>> }>(() => ({ entries: {} }));
  const active = new Map<string, { count: number; refresh: () => Promise<unknown> }>();
  const pending = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  let generation = 0;
  const get = (key: string): Resource<T> => store.getState().entries[key] ?? emptyResource;
  const patch = (key: string, values: Partial<Resource<T>>) =>
    store.setState((state) => {
      const entries = { ...state.entries, [key]: { ...get(key), ...values } };
      if (Object.keys(entries).length > 256) {
        const oldest = Object.keys(entries)
          .filter((id) => id !== key && !active.has(id) && !pending.has(id))
          .sort((a, b) => entries[a]!.updatedAt - entries[b]!.updatedAt)[0];
        if (oldest) delete entries[oldest];
      }
      return { entries };
    });
  const setData = (key: string, data: T, observedAt = Date.now()) =>
    patch(key, {
      data,
      error: null,
      loading: false,
      updatedAt: observedAt,
      revision: get(key).revision + 1,
    });
  const reset = () => {
    generation++;
    for (const work of pending.values()) work.controller.abort();
    pending.clear();
    store.setState({ entries: {} });
  };
  const result = {
    name,
    store,
    active,
    pending,
    get,
    patch,
    setData,
    reset,
    generation: () => generation,
  };
  resources.set(name, result);
  return result;
}
export type ResourceStore<T> = ReturnType<typeof createResourceStore<T>>;
export async function refreshStores(names?: string[]) {
  const tasks = [...resources]
    .filter(([name]) => !names || names.includes(name))
    .flatMap(([, resource]) => [...resource.active.values()].map((entry) => entry.refresh()));
  await Promise.all(tasks);
}
export function clearWalletStores() {
  for (const name of ["wallet-orders", "positions", "payout-credits"]) resources.get(name)?.reset();
}
