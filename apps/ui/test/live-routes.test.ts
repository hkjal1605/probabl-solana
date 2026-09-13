import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { GET as gatewayGet, POST as gatewayPost } from "@/app/api/gateway/[...path]/route";
import { GET as indexerGet } from "@/app/api/indexer/[...path]/route";
import { POST as retiredMode } from "@/app/api/mode/route";

describe("real-only UI routing", () => {
  test("legacy cookies cannot replace indexed responses or block real reads", async () => {
    const original = globalThis.fetch;
    const calls: { url: URL; auth: string | null }[] = [];
    globalThis.fetch = (async (url, init) => {
      calls.push({
        url: new URL(String(url)),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({ markets: [] });
    }) as typeof fetch;
    try {
      for (const cookie of ["probabl-mode=demo", "probabl-mode=live", ""]) {
        for (const method of ["GET", "POST"] as const) {
          const response = await (method === "GET" ? gatewayGet : gatewayPost)(
            new NextRequest("http://localhost:3001/api/gateway/markets", {
              method,
              headers: { cookie, authorization: "Bearer test-session" },
            }),
            { params: Promise.resolve({ path: ["markets"] }) },
          );
          expect(response.status).toBe(200);
          expect((await response.json()) as unknown).toEqual({ markets: [] });
          expect(calls.at(-1)?.auth).toBe("Bearer test-session");
          expect(calls.at(-1)?.url.pathname).toBe("/v1/markets");
        }
        const response = await indexerGet(
          new NextRequest("http://localhost:3001/api/indexer/markets?limit=10", {
            headers: { cookie },
          }),
          { params: Promise.resolve({ path: ["markets"] }) },
        );
        expect((await response.json()) as unknown).toEqual({ markets: [] });
        expect(calls.at(-1)?.url.pathname).toBe("/markets");
        expect(calls.at(-1)?.url.search).toBe("?limit=10");
        expect(response.headers.get("cache-control")).toContain("no-store");
      }
      expect(calls).toHaveLength(9);
    } finally {
      globalThis.fetch = original;
    }
  });
  test("a retired mode endpoint cannot create a simulated session", async () => {
    const response = await retiredMode();
    expect(response.status).toBe(410);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("location")).toBeNull();
  });
  test("public UI cannot proxy administrative or service-only indexer endpoints", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      throw new Error("Unexpected upstream");
    }) as unknown as typeof fetch;
    try {
      for (const handler of [gatewayGet, gatewayPost]) {
        const response = await handler(
          new NextRequest("http://localhost:3001/api/gateway/admin/evidence"),
          { params: Promise.resolve({ path: ["admin", "evidence"] }) },
        );
        expect(response.status).toBe(404);
      }
      const response = await indexerGet(
        new NextRequest("http://localhost:3001/api/indexer/internal"),
        { params: Promise.resolve({ path: ["internal"] }) },
      );
      expect(response.status).toBe(404);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });
  test("upstream failure is an error, never a fabricated market or successful action", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    try {
      for (const handler of [gatewayGet, gatewayPost, indexerGet]) {
        const response = await handler(
          new NextRequest("http://localhost:3001/api/indexer/markets"),
          { params: Promise.resolve({ path: ["markets"] }) },
        );
        expect(response.status).toBe(503);
        expect(await response.json()).not.toHaveProperty("markets");
      }
    } finally {
      globalThis.fetch = original;
    }
  });
});
