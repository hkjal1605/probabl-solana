/** Share identical subscriptions across components; close on last unsubscribe. */
const streams = new Map<
  string,
  { source: EventSource; listeners: Set<(value: unknown) => void>; errors: Set<() => void> }
>();
export function subscribeSpot(
  url: string,
  update: (value: unknown) => void,
  unavailable: () => void,
) {
  let entry = streams.get(url);
  if (!entry) {
    const source = new EventSource(url);
    entry = { source, listeners: new Set(), errors: new Set() };
    const shared = entry;
    source.addEventListener("prices", (event) => {
      try {
        const value = JSON.parse((event as MessageEvent).data);
        for (const listener of shared.listeners) listener(value);
      } catch {
        for (const listener of shared.errors) listener();
      }
    });
    source.addEventListener("unavailable", () => {
      for (const listener of shared.errors) listener();
    });
    source.onerror = () => {
      for (const listener of shared.errors) listener();
    };
    streams.set(url, entry);
  }
  entry.listeners.add(update);
  entry.errors.add(unavailable);
  return () => {
    entry.listeners.delete(update);
    entry.errors.delete(unavailable);
    if (!entry.listeners.size) {
      entry.source.close();
      streams.delete(url);
    }
  };
}
