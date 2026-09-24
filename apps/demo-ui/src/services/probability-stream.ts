import { subscribeProbabilityFeed } from "@/protocol/engine";
import type { ProbabilityView } from "@/types/api";

type Status = "connecting" | "live" | "reconnecting";

/** One shared subscription per condition, mirroring the streaming read path. */
export function subscribeProbability(
  condition: string,
  update: (value: ProbabilityView) => void,
  status: (value: Status) => void,
) {
  if (!/^0x[0-9a-f]{64}$/.test(condition.toLowerCase())) {
    status("reconnecting");
    return () => {};
  }
  status("connecting");
  const stop = subscribeProbabilityFeed(condition, (value) => {
    status("live");
    update(value);
  });
  return stop;
}
