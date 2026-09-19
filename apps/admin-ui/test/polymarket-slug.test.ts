import { afterEach, expect, test } from "bun:test";
import { normalizeGammaMarket } from "@conditional-stocks/market-data";
import { NextRequest } from "next/server";
import { POST } from "../src/app/api/solana/[...path]/route";
import { fetchMarketMetadata } from "../src/lib/admin-api";
import { parseMarketSlug } from "../src/lib/polymarket-slug";

const slug = "clarity-act-signed-into-law-in-2026";
const gammaUrl = `https://gamma-api.polymarket.com/markets/slug/${slug}`;
const apiUrl = "https://api-solana.probabl.trade/v1/admin/polymarket/metadata/fetch";
const path = ["admin", "polymarket", "metadata", "fetch-by-slug"];
const raw = {
  id: "1163699",
  slug,
  conditionId: `0x${"12".repeat(32)}`,
  active: true,
  closed: false,
  negRisk: false,
  outcomes: '["Yes","No"]',
  clobTokenIds: '["111","222"]',
  question: "Clarity Act signed into law in 2026?",
  description: "Test rules",
  endDate: "2027-01-01T00:00:00Z",
};
const snapshot = {
  snapshotId: "immutable-snapshot",
  normalized: normalizeGammaMarket(raw),
  rawHash: `0x${"34".repeat(32)}`,
  rawPayload: raw,
};
const originalFetch = globalThis.fetch;
const originalOrigin = process.env.API_URL;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalOrigin === undefined) delete process.env.API_URL;
  else process.env.API_URL = originalOrigin;
});
function request(body: unknown = { marketSlug: slug }, authorization = "Bearer test-session") {
  delete process.env.API_URL;
  return POST(
    new NextRequest(`http://localhost:3002/api/solana/${path.join("/")}`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ path }) },
  );
}

test("slugs are trimmed and bounded; URLs, traversal and ambiguous input are rejected", () => {
  expect(parseMarketSlug(`  ${slug}\n`)).toBe(slug);
  expect(parseMarketSlug("a".repeat(512))).toHaveLength(512);
  for (const value of [
    null,
    42,
    {},
    [],
    "",
    "   ",
    "../secret",
    "a/b",
    "a?b=1",
    "a#b",
    "a%2fb",
    `https://polymarket.com/event/${slug}`,
    "//evil.test",
    "UPPERCASE",
    "a b",
    "a\\b",
    "a\nb",
    "a".repeat(513),
  ])
    expect(() => parseMarketSlug(value)).toThrow("market slug");
});

test("both forms' shared client sends a slug and operator session to the Solana API proxy", async () => {
  let calls = 0;
  globalThis.fetch = (async (url, init) => {
    calls++;
    expect(String(url)).toBe(`/api/solana/${path.join("/")}`);
    expect(JSON.parse(String(init?.body))).toEqual({ marketSlug: slug });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-session");
    expect(init?.method).toBe("POST");
    return Response.json(snapshot);
  }) as typeof fetch;
  expect(await fetchMarketMetadata<typeof snapshot>("test-session", ` ${slug} `)).toEqual(snapshot);
  expect(() => fetchMarketMetadata("test-session", "https://evil.test")).toThrow("market slug");
  await expect(fetchMarketMetadata("", slug)).rejects.toMatchObject({ status: 401 });
  expect(calls).toBe(1);
});

test("Solana API proxy resolves the exact slug and returns the saved snapshot", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (url, init) => {
    calls.push(String(url));
    expect(init?.redirect).toBe("error");
    expect(init?.cache).toBe("no-store");
    expect(init?.signal).toBeDefined();
    if (String(url) === gammaUrl) {
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      expect(init?.body).toBeUndefined();
      return Response.json(raw);
    }
    expect(String(url)).toBe(apiUrl);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ gammaMarketId: "1163699" });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-session");
    return Response.json(snapshot, {
      headers: {
        "x-request-id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "set-cookie": "must-not-forward",
      },
    });
  }) as typeof fetch;
  const response = await request({ marketSlug: ` ${slug} ` });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(snapshot);
  expect(calls).toEqual([gammaUrl, apiUrl]);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-request-id")).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  expect(response.headers.get("set-cookie")).toBeNull();
});

test("missing sessions and malformed/ambiguous request bodies fail before any source access", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error("Unexpected fetch");
  }) as unknown as typeof fetch;
  for (const header of ["", "Basic test", "Bearer ", "Bearer token extra"])
    expect((await request({ marketSlug: slug }, header)).status).toBe(401);
  for (const body of [
    null,
    [],
    {},
    { gammaMarketId: "1163699" },
    { marketSlug: slug, gammaMarketId: "42" },
    { marketSlug: "../secret" },
    { marketSlug: 42 },
    { marketSlug: "a".repeat(3000) },
  ])
    expect((await request(body)).status).toBe(400);
  const malformed = new NextRequest(`http://localhost/api/solana/${path.join("/")}`, {
    method: "POST",
    headers: { authorization: "Bearer test" },
    body: "{invalid",
  });
  expect((await POST(malformed, { params: Promise.resolve({ path }) })).status).toBe(400);
  expect(calls).toBe(0);
});

test("unknown and multi-market event slugs never pick an arbitrary market", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const response = await request();
  expect(response.status).toBe(404);
  expect((await response.json()).error.message).toContain("individual market's slug");
  expect(calls).toBe(1);
});

test("invalid source identities, malformed metadata and unsupported markets never reach the API", async () => {
  for (const [body, status] of [
    [{ ...raw, slug: "another-market" }, 502],
    [{ ...raw, id: "event-id" }, 502],
    [{ ...raw, id: 1163699 }, 502],
    [{ ...raw, id: "0" }, 502],
    [{ ...raw, conditionId: "invalid" }, 502],
    [{ id: "158505", slug, markets: [raw] }, 502],
    [[raw], 502],
    [{ ...raw, negRisk: true }, 422],
    [{ ...raw, outcomes: '["Yes","No","Maybe"]' }, 422],
  ] as const) {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json(body);
    }) as unknown as typeof fetch;
    expect((await request()).status).toBe(status);
    expect(calls).toBe(1);
  }
});

test("source errors, bad JSON, redirect and response size limits fail closed without retries", async () => {
  for (const [make, status] of [
    [() => new Response("limited", { status: 429 }), 503],
    [() => new Response("failed", { status: 500 }), 503],
    [() => new Response(null, { status: 302, headers: { location: "https://evil.test" } }), 503],
    [() => new Response("{broken"), 502],
    [() => new Response(null, { status: 204 }), 502],
    [() => new Response("{}", { headers: { "content-length": "5242881" } }), 502],
    [
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(5242881));
              controller.close();
            },
          }),
        ),
      502,
    ],
    [
      () => {
        throw new Error("private diagnostic must not leak");
      },
      503,
    ],
  ] as const) {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return make();
    }) as unknown as typeof fetch;
    const response = await request();
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("private diagnostic");
    expect(calls).toBe(1);
  }
});

test("deployed API authentication and authorization failures propagate with no retry", async () => {
  for (const status of [401, 403, 409, 429, 503]) {
    const error = { error: { message: "Operator request rejected" } };
    let calls = 0;
    globalThis.fetch = (async (url) => {
      calls++;
      return String(url) === gammaUrl ? Response.json(raw) : Response.json(error, { status });
    }) as typeof fetch;
    const response = await request();
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(error);
    expect(calls).toBe(2);
  }
});

test("canonical ID, slug, condition and outcome mapping must survive the ingestor round trip", async () => {
  for (const overrides of [
    { gammaMarketId: "42" },
    { slug: "another-market" },
    { conditionId: `0x${"56".repeat(32)}` },
    { mappingHash: `0x${"78".repeat(32)}` },
  ]) {
    globalThis.fetch = (async (url) =>
      String(url) === gammaUrl
        ? Response.json(raw)
        : Response.json({
            ...snapshot,
            normalized: { ...snapshot.normalized, ...overrides },
          })) as typeof fetch;
    const response = await request();
    expect(response.status).toBe(409);
    expect((await response.json()).error.message).toContain("does not match");
  }
});

test("an unavailable API cannot be replaced with a fabricated Gamma snapshot", async () => {
  for (const [make, status] of [
    [() => Response.json(raw), 409],
    [() => Response.json({ ...snapshot, snapshotId: "" }), 409],
    [() => new Response("{broken"), 502],
    [() => new Response(null, { status: 307, headers: { location: "https://evil.test" } }), 502],
    [
      () => {
        throw new Error("offline");
      },
      503,
    ],
  ] as const) {
    let calls = 0;
    globalThis.fetch = (async (url) => {
      calls++;
      return String(url) === gammaUrl ? Response.json(raw) : make();
    }) as typeof fetch;
    expect((await request()).status).toBe(status);
    expect(calls).toBe(2);
  }
});
