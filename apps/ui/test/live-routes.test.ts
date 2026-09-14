import { afterEach, expect, test } from "bun:test";
import { requestJson } from "../src/services/api";
import { apiUrl, API_URL } from "../src/services/constants";
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
test("browser calls target the configured API directly without cookies or Next proxies", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (url, init) => {
    calls.push(String(url));
    expect(init?.credentials).toBe("omit");
    return Response.json({ markets: [] });
  }) as typeof fetch;
  expect(await requestJson<{ markets: unknown[] }>("/markets")).toEqual({ markets: [] });
  expect(calls).toEqual([API_URL + "/markets"]);
});
test("foreign origins, protocol-relative URLs and backslashes cannot receive API tokens", () => {
  for (const path of ["https://attacker.test/x", "//attacker.test/x", "/\\\\attacker.test"])
    expect(() => apiUrl(path)).toThrow();
});
test("failed writes are never automatically retried", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({ error: { message: "Unavailable" } }, { status: 503 }); }) as unknown as typeof fetch;
  await expect(requestJson("/v1/orders/transaction", { body: {} })).rejects.toThrow("Unavailable");
  expect(calls).toBe(1);
});
test("main UI contains no Next API handlers or server data loader", async () => {
  const glob = new Bun.Glob("**/route.{ts,tsx}");
  const routes = [...glob.scanSync(new URL("../src/app", import.meta.url).pathname)];
  expect(routes).toEqual([]);
  const modules = new Bun.Glob("**/*.tsx");
  for (const file of modules.scanSync(new URL("../src/modules", import.meta.url).pathname)) {
    const source = await Bun.file(new URL("../src/modules/" + file, import.meta.url)).text();
    expect(source).not.toContain("serverApi");
    expect(source).not.toContain("@tanstack/react-query");
  }
});
