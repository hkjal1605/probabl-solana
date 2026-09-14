import { SOLANA_STREAM_ORIGIN } from "@conditional-stocks/shared/endpoints";
import { parseProbabilityMessage, probabilityStreamUrl, expireProbability } from "./probability";
import type { ProbabilityView } from "@/types/api";
export function subscribeProbability(
  condition: string,
  update: (value: ProbabilityView) => void,
  status: (value: "connecting" | "live" | "reconnecting") => void,
) {
  let socket: WebSocket | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    stopped = false,
    attempt = 0;
  const reconnect = () => {
    if (stopped) return;
    status("reconnecting");
    attempt++;
    timer = setTimeout(connect, Math.min(1000 * 2 ** attempt, 30_000));
  };
  const connect = () => {
    if (stopped) return;
    status(attempt ? "reconnecting" : "connecting");
    try {
      socket = new WebSocket(
        probabilityStreamUrl(
          condition,
          process.env.NEXT_PUBLIC_POLYMARKET_STREAM_URL ?? SOLANA_STREAM_ORIGIN,
        ),
      );
    } catch {
      reconnect();
      return;
    }
    socket.onopen = () => {
      attempt = 0;
      status("live");
    };
    socket.onmessage = (event) => {
      if (stopped) return;
      try {
        update(
          expireProbability(parseProbabilityMessage(JSON.parse(String(event.data)), condition)),
        );
      } catch {
        socket?.close();
      }
    };
    socket.onerror = () => socket?.close();
    socket.onclose = reconnect;
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    socket?.close();
  };
}
