import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";

const dom = new Window({ url: "http://localhost:3001" });
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "Element",
  "Node",
  "Document",
  "DocumentFragment",
  "ShadowRoot",
  "MutationObserver",
  "ResizeObserver",
  "Event",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "FocusEvent",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: Reflect.get(dom, key),
  });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { Segmented } = await import("../../src/components/ui/segmented");
const { useConfirmation } = await import("../../src/hooks/useConfirmation");
const { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } = await import(
  "../../src/components/ui/select"
);
const { Toaster, toast } = await import("../../src/components/ui/toast");
const { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } =
  await import("../../src/components/ui/dialog");
const { Button } = await import("../../src/components/ui/button");
const { FieldSet } = await import("../../src/components/ui/field");
const { Tabs, TabsList, TabsTrigger, TabsContent } = await import("../../src/components/ui/tabs");
const { Accordion, AccordionItem, AccordionTrigger, AccordionContent } = await import(
  "../../src/components/ui/accordion"
);
const { Avatar, AvatarImage, AvatarFallback } = await import("../../src/components/ui/avatar");
const host = document.createElement("div");
document.body.appendChild(host);
let root = createRoot(host);
async function render(node: React.ReactNode) {
  await act(async () => {
    root.render(node);
  });
}
async function click(element: Element | null) {
  expect(element).not.toBeNull();
  await act(async () => {
    (element as HTMLElement).click();
  });
  // Flush the popup's animation-frame positioning and focus effects as part of the interaction.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}
const button = (text: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) ?? null;
afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(host);
});
afterAll(async () => {
  await act(async () => root.unmount());
  await dom.happyDOM.close();
});

test("single-choice toggles cannot deselect, switch correctly, and honor disabled fieldsets", async () => {
  function Controls({ disabled = false }: { disabled?: boolean }) {
    const [value, setValue] = useState("Buy");
    return (
      <FieldSet disabled={disabled}>
        <Segmented
          disabled={disabled}
          label="Side"
          value={value}
          options={["Buy", "Sell"]}
          onChange={setValue}
        />
      </FieldSet>
    );
  }
  await render(<Controls />);
  expect(button("Buy")?.getAttribute("aria-pressed")).toBe("true");
  await click(button("Buy"));
  expect(button("Buy")?.getAttribute("aria-pressed")).toBe("true");
  await click(button("Sell"));
  expect(button("Sell")?.getAttribute("aria-pressed")).toBe("true");
  await render(<Controls disabled />);
  await click(button("Buy"));
  expect(button("Sell")?.getAttribute("aria-pressed")).toBe("true");
});

test("select renders labels before opening and updates the selected value", async () => {
  function Assets() {
    const [value, setValue] = useState("mint-address");
    return (
      <Select
        value={value}
        onValueChange={(next) => {
          if (next !== null) setValue(next);
        }}
        items={{ "mint-address": "USDC", "another-mint": "BTC" }}
      >
        <SelectTrigger aria-label="Asset">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="mint-address">USDC</SelectItem>
            <SelectItem value="another-mint">BTC</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    );
  }
  await render(<Assets />);
  expect(host.querySelector("[data-slot=select-value]")?.textContent).toBe("USDC");
  await click(host.querySelector("[data-slot=select-trigger]"));
  await click(
    [...document.querySelectorAll('[role="option"]')].find((el) =>
      el.textContent?.includes("BTC"),
    ) ?? null,
  );
  expect(host.querySelector("[data-slot=select-value]")?.textContent).toBe("BTC");
});

test("tabs retain manual activation and correctly switch panels", async () => {
  await render(
    <Tabs defaultValue="positions">
      <TabsList aria-label="Holdings">
        <TabsTrigger value="positions">Positions</TabsTrigger>
        <TabsTrigger value="orders">Orders</TabsTrigger>
      </TabsList>
      <TabsContent value="positions">Your holdings</TabsContent>
      <TabsContent value="orders">Your orders</TabsContent>
    </Tabs>,
  );
  await act(async () => {
    button("Orders")?.focus();
  });
  expect(button("Positions")?.getAttribute("aria-selected")).toBe("true");
  await click(button("Orders"));
  expect(button("Orders")?.getAttribute("aria-selected")).toBe("true");
  expect(host.querySelector('[role="tabpanel"]:not([hidden])')?.textContent).toBe("Your orders");
});

test("accordion disclosures open and close with accessible expanded state", async () => {
  await render(
    <Accordion>
      <AccordionItem value="advanced">
        <AccordionTrigger>Advanced controls</AccordionTrigger>
        <AccordionContent>Time in force</AccordionContent>
      </AccordionItem>
    </Accordion>,
  );
  expect(button("Advanced")?.getAttribute("aria-expanded")).toBe("false");
  await click(button("Advanced"));
  expect(button("Advanced")?.getAttribute("aria-expanded")).toBe("true");
  expect(host.textContent).toContain("Time in force");
  await click(button("Advanced"));
  expect(button("Advanced")?.getAttribute("aria-expanded")).toBe("false");
});

test("avatars show initials when an issuer image is unavailable", async () => {
  await render(
    <Avatar>
      <AvatarImage src="/missing-token-image.svg" alt="" />
      <AvatarFallback>BTC</AvatarFallback>
    </Avatar>,
  );
  expect(host.querySelector("[data-slot=avatar-fallback]")?.textContent).toBe("BTC");
});

test("Base toast manager renders notification titles", async () => {
  await render(<Toaster />);
  let id = "";
  await act(async () => {
    id = toast.add({ title: "Order submitted", type: "success" });
  });
  expect(document.body.textContent).toContain("Order submitted");
  await act(async () => {
    toast.close(id);
  });
});

test("render-composed dialog trigger opens a labelled dialog without nested buttons", async () => {
  await render(
    <Dialog>
      <DialogTrigger render={<Button />}>Wallet details</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Trading wallet</DialogTitle>
          <DialogDescription>Wallet information</DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>,
  );
  expect(host.querySelector("button button")).toBeNull();
  await click(button("Wallet details"));
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Trading wallet");
  await click(button("Close"));
  expect(document.querySelector('[role="dialog"][data-open]')).toBeNull();
});

test("fee consent accepts only explicit confirmation; cancellation, scope changes and unmount decline", async () => {
  let request!: (message: string) => Promise<boolean>;
  function Consent({ scope }: { scope: string }) {
    const state = useConfirmation(scope);
    request = state.confirm;
    return state.confirmation;
  }
  await render(<Consent scope="wallet:A" />);
  let result!: Promise<boolean>;
  await act(async () => {
    result = request("Fee: 1 USDC");
  });
  await click(button("Cancel"));
  expect(await result).toBe(false);
  await act(async () => {
    result = request("Fee: 2 USDC");
  });
  await click(button("Accept fees"));
  expect(await result).toBe(true);
  await act(async () => {
    result = request("Fee: 3 USDC");
  });
  await render(<Consent scope="wallet:B" />);
  expect(await result).toBe(false);
  await act(async () => {
    result = request("Fee: 4 USDC");
  });
  await render(null);
  expect(await result).toBe(false);
});
