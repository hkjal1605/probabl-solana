import { mock } from "bun:test";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost:3002" });
for (const key of [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "localStorage",
  "sessionStorage",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLAnchorElement",
  "Element",
  "Node",
  "Document",
  "DocumentFragment",
  "ShadowRoot",
  "MutationObserver",
  "ResizeObserver",
  "IntersectionObserver",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "FocusEvent",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "Blob",
  "URL",
]) {
  const value = Reflect.get(dom, key);
  if (value === undefined) continue;
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

export const navigation = { pathname: "/", pushed: [] as string[] };

mock.module("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({
    push: (href: string) => navigation.pushed.push(href),
    replace: (href: string) => navigation.pushed.push(href),
    prefetch: () => {},
    back: () => {},
    forward: () => {},
    refresh: () => {},
  }),
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("not found");
  },
}));

// Canvas-backed charts cannot render in a DOM-only environment.
mock.module("lightweight-charts", () => ({
  ColorType: { Solid: "solid" },
  CrosshairMode: { Normal: 0 },
  LineSeries: {},
  createChart: () => ({
    addSeries: () => ({ setData: () => {} }),
    subscribeCrosshairMove: () => {},
    unsubscribeCrosshairMove: () => {},
    timeScale: () => ({ fitContent: () => {} }),
    remove: () => {},
  }),
}));

export const dispose = () => dom.happyDOM.close();
