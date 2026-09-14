import type { ProbabilityView } from "@/types/api";
import {
  expireCachedProbability,
  parseProbabilityMessage,
  probabilityStreamUrl,
} from "./probability";

type Status = "connecting" | "live" | "reconnecting";
const subscriptions = new Map<
  string,
  {
    source: EventSource;
    listeners: Set<(value: ProbabilityView) => void>;
    statuses: Set<(value: Status) => void>;
    latest?: ProbabilityView;
    status: Status;
  }
>();

/** One API-owned SSE connection per condition, shared by all subscribers. */
export function subscribeProbability(
  condition: string,
  update: (value: ProbabilityView) => void,
  status: (value: Status) => void,
) {
  const canonical = condition.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(canonical)) {
    status("reconnecting");
    return () => {};
  }
  let entry = subscriptions.get(canonical);
  if (!entry) {
    let source: EventSource;
    try {
      source = new EventSource(probabilityStreamUrl(canonical));
    } catch {
      status("connecting");
      status("reconnecting");
      return () => {};
    }
    entry = { source, listeners: new Set(), statuses: new Set(), status: "connecting" };
    const shared = entry;
    const state = (value: Status) => {
      shared.status = value;
      for (const listener of shared.statuses) listener(value);
    };
    source.addEventListener("probability", (event) => {
      try {
        const value = expireCachedProbability(
          parseProbabilityMessage(JSON.parse((event as MessageEvent).data), canonical),
        );
        shared.latest = value;
        state("live");
        for (const listener of shared.listeners) listener(value);
      } catch {
        state("reconnecting");
      }
    });
    source.addEventListener("unavailable", () => state("reconnecting"));
    source.onerror = () => state("reconnecting");
    subscriptions.set(canonical, entry);
  }
  entry.listeners.add(update);
  entry.statuses.add(status);
  status(entry.status);
  if (entry.latest && entry.status === "live") update(expireCachedProbability(entry.latest));
  return () => {
    entry.listeners.delete(update);
    entry.statuses.delete(status);
    if (!entry.listeners.size) {
      entry.source.close();
      subscriptions.delete(canonical);
    }
  };
}
