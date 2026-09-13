"use client";

import { useEffect, useState } from "react";
import { expireProbability, parseProbabilityMessage } from "@/lib/api/probability";
import type { ProbabilityView } from "@/lib/api/types";
import { logger } from "@/lib/logger";

export function useProbabilityStream(conditionId: string, initial: ProbabilityView) {
  const enabled = Boolean(conditionId);
  const [probability, setProbability] = useState(initial);
  const [connection, setConnection] = useState<"disabled" | "connecting" | "live" | "reconnecting">(
    "disabled",
  );
  useEffect(() => {
    setProbability((previous) =>
      Date.parse(previous.observedAt ?? "") > Date.parse(initial.observedAt ?? "") &&
      connection === "live"
        ? previous
        : expireProbability(initial),
    );
  }, [initial, connection]);
  useEffect(() => {
    if (!enabled) return;
    const base = process.env.NEXT_PUBLIC_POLYMARKET_STREAM_URL;
    const staleTimer = setInterval(() => setProbability((value) => expireProbability(value)), 1000);
    if (!base) return () => clearInterval(staleTimer);
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let attempt = 0;
    const connect = () => {
      setConnection(attempt === 0 ? "connecting" : "reconnecting");
      try {
        socket = new WebSocket(
          `${base.replace(/\/$/, "")}/v1/polymarket/conditions/${encodeURIComponent(conditionId)}/stream`,
        );
      } catch {
        setConnection("disabled");
        setProbability((value) => ({ ...value, quality: "disconnected", value: null }));
        return;
      }
      socket.onopen = () => {
        logger.info("probability.stream.connected", { conditionId });
        attempt = 0;
        setConnection("live");
      };
      socket.onmessage = (event) => {
        try {
          setProbability(
            expireProbability(parseProbabilityMessage(JSON.parse(String(event.data)), conditionId)),
          );
        } catch (error) {
          logger.warn("probability.message.rejected", { conditionId, error });
          setProbability((value) => ({ ...value, quality: "disconnected", value: null }));
        }
      };
      socket.onclose = () => {
        if (stopped) return;
        attempt += 1;
        logger.warn("probability.stream.disconnected", { conditionId, retryAttempt: attempt });
        setConnection("reconnecting");
        setProbability((value) => ({ ...value, quality: "disconnected", value: null }));
        timer = setTimeout(connect, Math.min(1_000 * 2 ** attempt, 30_000));
      };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => {
      stopped = true;
      clearInterval(staleTimer);
      if (timer) clearTimeout(timer);
      socket?.close();
    };
  }, [conditionId, enabled]);
  return { connection, probability };
}
