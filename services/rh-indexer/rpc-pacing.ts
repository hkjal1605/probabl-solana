import { fallback, http, type Transport } from "viem";

/** Space request admission, not responses: slow RPC calls may still run concurrently. */
export function requestAdmission(
  requestsPerSecond: number,
  clock = () => performance.now(),
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
) {
  if (!Number.isSafeInteger(requestsPerSecond) || requestsPerSecond < 1 || requestsPerSecond > 1000)
    throw new Error("RPC request rate must be an integer between 1 and 1000");
  const spacing = 1000 / requestsPerSecond;
  let nextAt = 0;
  let tail = Promise.resolve();
  return () => {
    const admission = tail.then(async () => {
      // Recheck after waking: timers can fire early. Base the next slot on actual
      // admission time so a delayed event loop never releases a catch-up burst.
      while (clock() < nextAt) await sleep(nextAt - clock());
      nextAt = clock() + spacing;
    });
    tail = admission.catch(() => {});
    return admission;
  };
}

export function pacedTransport(base: Transport, admit: () => Promise<void>): Transport {
  return (parameters) => {
    const transport = base(parameters);
    return {
      ...transport,
      request: (async (...args: Parameters<typeof transport.request>) => {
        await admit();
        return transport.request(...args);
      }) as typeof transport.request,
    };
  };
}

export function pacedRpc(urls: string[], requestsPerSecond: number): Transport {
  if (urls.length === 0) throw new Error("At least one RPC URL is required");
  const admit = requestAdmission(requestsPerSecond);
  const transports = urls.map((url) => pacedTransport(http(url, { retryCount: 0 }), admit));
  // Ponder owns retry/backoff. Pace every fallback attempt through the same gate.
  const first = transports[0];
  if (!first) throw new Error("At least one RPC transport is required");
  return transports.length === 1 ? first : fallback(transports, { retryCount: 0 });
}
