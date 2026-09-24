"use client";
import { useEffect, useState } from "react";
import { SEARCH_DELAY_MS } from "../utils/searchMarkets";

export function useDebouncedSearch(value: string) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return settled;
}
