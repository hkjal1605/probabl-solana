"use client";
import { useEffect, useState } from "react";
import { readFreshness, type ReadState } from "@/services/read-policy";

export function useReadFreshness(query: ReadState, maxAgeMs = 30_000) {
  const [, setNow] = useState(Date.now);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, 2000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);
  return readFreshness(query, Date.now(), maxAgeMs);
}
