import { expect, test } from "bun:test";
import { adminRequest, requestJson, SESSION_EXPIRED_EVENT } from "../src/lib/admin-api";
import { createAdminSession, setRequestSession } from "../src/lib/admin-session";

test("admin requests reject missing sessions and unsafe paths before a network call", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return Response.json({});
  }) as unknown as typeof fetch;
  try {
    await expect(adminRequest("", "admin/evidence")).rejects.toThrow("Sign in");
    for (const path of [
      "https://example.test",
      "//example.test",
      "/api/solana/../admin",
      "/api/solana/https://example.test",
      "/api/solana/admin?redirect=1",
      "/api/solana/admin\\evil",
    ])
      await expect(requestJson(path)).rejects.toThrow("Invalid");
    expect(calls).toBe(0);
  } finally {
    globalThis.fetch = original;
  }
});
test("errors and malformed JSON never become fake success or empty data; mutations do not retry", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    for (const response of [
      Response.json({ error: { message: "MARKET_ADMIN session required" } }, { status: 403 }),
      new Response("bad upstream", { status: 503 }),
      new Response("not JSON", { status: 200 }),
    ]) {
      globalThis.fetch = (async (_url, init) => {
        calls++;
        expect(init?.redirect).toBe("error");
        expect(init?.cache).toBe("no-store");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-session");
        expect(init?.signal).toBeDefined();
        return response;
      }) as typeof fetch;
      await expect(
        adminRequest("test-session", "admin/evidence", {
          method: "POST",
          body: "{}",
          headers: { authorization: "Bearer unwanted-override" },
        }),
      ).rejects.toThrow();
    }
    expect(calls).toBe(3);
    globalThis.fetch = (async () => Response.json({ packets: [] })) as unknown as typeof fetch;
    expect(await adminRequest<{ packets: unknown[] }>("test-session", "admin/evidence")).toEqual({
      packets: [],
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("browser requests enforce expiry before fetch and report upstream 401 for the matching token", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const events = new EventTarget();
  const expired: string[] = [];
  events.addEventListener(SESSION_EXPIRED_EVENT, (event) => {
    expired.push((event as CustomEvent<string>).detail);
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: events });
  const token = "b".repeat(64);
  const owner = "4o2JYy6ktdZEfaUVHGwdCbvMyypZ1NRCDpyS1rfY9q8z";
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return Response.json({ error: { message: "Session expired" } }, { status: 401 });
  }) as unknown as typeof fetch;
  try {
    setRequestSession(createAdminSession("test", owner, token, Date.now() - 5 * 60 * 60 * 1000));
    await expect(adminRequest(token, "admin/evidence")).rejects.toThrow("four-hour");
    expect(calls).toBe(0);
    expect(expired).toEqual([token]);

    setRequestSession(createAdminSession("test", owner, token));
    await expect(adminRequest(token, "admin/evidence")).rejects.toThrow("Session expired");
    expect(calls).toBe(1);
    expect(expired).toEqual([token, token]);

    setRequestSession(null);
    await expect(adminRequest(token, "admin/evidence")).rejects.toThrow("four-hour");
    expect(calls).toBe(1);
  } finally {
    setRequestSession(null);
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
