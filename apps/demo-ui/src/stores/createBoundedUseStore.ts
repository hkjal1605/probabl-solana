import { type StoreApi, useStore } from "zustand";

const createBoundedUseStore =
  <T>(store: StoreApi<T>) =>
  <S>(selector: (state: T) => S) =>
    useStore(store, selector);
export default createBoundedUseStore;
