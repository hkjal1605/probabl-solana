import { subscribe } from "@/protocol/engine";

/** Price updates arrive on the shared protocol tick rather than a socket. */
export function subscribeSpot(
  _url: string,
  update: (value: unknown) => void,
  _unavailable: () => void,
) {
  return subscribe(() => update(null));
}
