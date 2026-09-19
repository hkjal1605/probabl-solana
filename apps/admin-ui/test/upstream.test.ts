import { afterEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { upstreamUrl } from "../src/lib/upstream";
import { GET as solanaGet } from "../src/app/api/solana/[...path]/route";
import { GET as indexerGet } from "../src/app/api/indexer/[...path]/route";

const original = {
  API_URL: process.env.API_URL,
  INDEXER_URL: process.env.INDEXER_URL,
};
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("admin defaults use the deployed Solana API and indexer", async () => {
  delete process.env.API_URL;
  delete process.env.INDEXER_URL;
  expect(upstreamUrl("api")).toBe("https://api-solana.probabl.trade");
  expect(upstreamUrl("indexer")).toBe("https://api-solana.probabl.trade");
  const calls: string[] = [];
  const redirects: (RequestRedirect | undefined)[] = [];
  globalThis.fetch = (async (url, init) => {
    calls.push(String(url));
    redirects.push(init?.redirect);
    return Response.json({});
  }) as typeof fetch;
  const gateway = await solanaGet(
    new NextRequest("http://localhost:3002/api/solana/admin/evidence"),
    {
      params: Promise.resolve({ path: ["admin", "evidence"] }),
    },
  );
  const indexer = await indexerGet(
    new NextRequest("http://localhost:3002/api/indexer/markets?limit=10"),
    {
      params: Promise.resolve({ path: ["markets"] }),
    },
  );
  expect(calls).toEqual([
    "https://api-solana.probabl.trade/v1/admin/evidence",
    "https://api-solana.probabl.trade/markets?limit=10",
  ]);
  expect(redirects).toEqual(["manual", "manual"]);
  expect(gateway.status).toBe(200);
  expect(indexer.status).toBe(200);
});

test("indexer redirects remain fail-closed on edge runtimes", async () => {
  globalThis.fetch = (async (_input, _init) =>
    new Response(null, {
      status: 302,
      headers: { location: "https://attacker.invalid" },
    })) as typeof fetch;
  const response = await indexerGet(
    new NextRequest("http://localhost:3002/api/indexer/markets"),
    { params: Promise.resolve({ path: ["markets"] }) },
  );
  expect(response.status).toBe(503);
  expect(response.headers.get("location")).toBeNull();
});

test("explicit origins are read lazily and local-validator overrides remain possible", () => {
  process.env.API_URL = "http://127.0.0.1:3000/";
  process.env.INDEXER_URL = "http://127.0.0.1:42069/";
  expect(upstreamUrl("api")).toBe("http://127.0.0.1:3000");
  expect(upstreamUrl("indexer")).toBe("http://127.0.0.1:42069");
  process.env.API_URL = "https://api.example.test/";
  expect(upstreamUrl("api")).toBe("https://api.example.test");
});

test("invalid, credential-bearing or path-prefixed origins fail closed", () => {
  for (const value of [
    "",
    "invalid",
    "ftp://api.test",
    "https://api.test/v1",
    "https://api.test?key=secret",
    "https://u:secret@api.test",
    "https://api.test/#fragment",
  ]) {
    for (const key of ["API_URL", "INDEXER_URL"] as const) {
      process.env[key] = value;
      expect(() =>
        upstreamUrl(key === "API_URL" ? "api" : "indexer"),
      ).toThrow();
    }
  }
});
