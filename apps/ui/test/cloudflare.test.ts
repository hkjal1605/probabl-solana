import { afterEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import {
  GET as gatewayGet,
  POST as gatewayPost,
} from "@/app/api/gateway/[...path]/route";
import { GET as indexerGet } from "@/app/api/indexer/[...path]/route";
import { upstreamUrl } from "@/lib/api/upstream";
import { validateCloudflareEnvironment } from "../scripts/cloudflare-preflight";
import { sanitizedEnvironmentModule } from "../scripts/cloudflare-sanitize";

const originalFetch = globalThis.fetch;
const originalEnvironment = { ...process.env };
const environment: Record<string, string | undefined> = process.env;
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ["API_URL", "INDEXER_URL", "PROBABL_HOSTING"]) {
    if (originalEnvironment[key] === undefined) delete environment[key];
    else environment[key] = originalEnvironment[key];
  }
});
const context = (path: string[]) => ({ params: Promise.resolve({ path }) });

describe("Workers runtime upstreams", () => {
  test("uses deployed HTTPS defaults on Node and reads explicit runtime settings lazily", () => {
    delete environment.PROBABL_HOSTING;
    delete environment.API_URL;
    delete environment.INDEXER_URL;
    expect(upstreamUrl("api")).toBe("https://api-solana.probabl.trade");
    expect(upstreamUrl("indexer")).toBe("https://api-solana.probabl.trade");
    environment.PROBABL_HOSTING = "cloudflare";
    environment.API_URL = "https://api.probabl.test/";
    expect(upstreamUrl("api")).toBe("https://api.probabl.test");
    environment.API_URL = "https://other.probabl.test";
    expect(upstreamUrl("api")).toBe("https://other.probabl.test");
  });

  test("rejects missing, insecure and ambiguous Worker origins", () => {
    environment.PROBABL_HOSTING = "cloudflare";
    for (const value of [
      undefined,
      "",
      "http://127.0.0.1:3000",
      "not-a-url",
      "https://api.test/v1",
      "https://api.test?key=value",
      "https://user:password@api.test",
      "https://api.test/#fragment",
    ]) {
      if (value === undefined) delete environment.API_URL;
      else environment.API_URL = value;
      expect(() => upstreamUrl("api")).toThrow();
    }
  });

  test("default gateway and indexer calls both target the deployed HTTPS origin", async () => {
    delete environment.PROBABL_HOSTING;
    delete environment.API_URL;
    delete environment.INDEXER_URL;
    const urls: string[] = [];
    globalThis.fetch = (async (url, init) => {
      urls.push(String(url));
      expect(init?.redirect).toBe("manual");
      return Response.json({ markets: [] });
    }) as typeof fetch;
    const gateway = await gatewayGet(
      new NextRequest("http://localhost:3001/api/gateway/system/readiness"),
      context(["system", "readiness"]),
    );
    const indexer = await indexerGet(
      new NextRequest("http://localhost:3001/api/indexer/markets?limit=10"),
      context(["markets"]),
    );
    expect(urls).toEqual([
      "https://api-solana.probabl.trade/v1/system/readiness",
      "https://api-solana.probabl.trade/markets?limit=10",
    ]);
    expect(gateway.status).toBe(200);
    expect(indexer.status).toBe(200);
  });

  test("explicit local-validator origins remain available outside Workers", () => {
    delete environment.PROBABL_HOSTING;
    environment.API_URL = "http://127.0.0.1:3000";
    environment.INDEXER_URL = "http://127.0.0.1:42069";
    expect(upstreamUrl("api")).toBe(environment.API_URL!);
    expect(upstreamUrl("indexer")).toBe(environment.INDEXER_URL!);
  });

  test("missing runtime bindings produce private 503 responses without any fetch", async () => {
    environment.PROBABL_HOSTING = "cloudflare";
    delete environment.API_URL;
    delete environment.INDEXER_URL;
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      throw new Error("must not fetch");
    }) as unknown as typeof fetch;
    for (const handler of [gatewayGet, indexerGet]) {
      const response = await handler(
        new NextRequest("https://ui.test/api/markets"),
        context(["markets"]),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(calls).toBe(0);
  });

  test("streams POST bytes and forwards only permitted headers", async () => {
    environment.API_URL = "https://api.probabl.test";
    let calls = 0;
    const payload = JSON.stringify({ amount: "9007199254740993123456789" });
    const request = new NextRequest(
      "https://ui.test/api/gateway/orders?mode=limit",
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-only",
          "content-type": "application/json",
          "idempotency-key": "test-order",
          cookie: "private-cookie=not-forwarded",
          "x-internal-token": "not-forwarded",
        },
        body: payload,
      },
    );
    globalThis.fetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls++;
      expect(String(url)).toBe("https://api.probabl.test/v1/orders?mode=limit");
      expect(init?.body).toBe(request.body);
      expect(await new Response(init?.body).text()).toBe(payload);
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer test-only");
      expect(headers.get("idempotency-key")).toBe("test-order");
      expect(headers.has("cookie")).toBe(false);
      expect(headers.has("x-internal-token")).toBe(false);
      expect(init?.redirect).toBe("manual");
      return Response.json(
        { error: "rate-limited" },
        {
          status: 429,
          headers: {
            "retry-after": "2",
            "x-request-id": "11111111-1111-4111-8111-111111111111",
            "set-cookie": "unsafe=yes",
            "cache-control": "public, max-age=600",
          },
        },
      );
    }) as typeof fetch;
    const response = await gatewayPost(request, context(["orders"]));
    expect(calls).toBe(1);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(response.headers.has("x-request-id")).toBe(true);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect<unknown>(await response.json()).toEqual({ error: "rate-limited" });
  });

  test("does not turn indexer proxy into a service endpoint or traversal tunnel", async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      throw new Error("must not fetch");
    }) as unknown as typeof fetch;
    for (const path of [
      ["internal"],
      ["health"],
      ["sql"],
      ["markets", ".."],
      ["markets", "%2f"],
    ]) {
      const response = await indexerGet(
        new NextRequest("https://ui.test/api/indexer/markets"),
        context(path),
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(calls).toBe(0);
  });

  test("indexer reads preserve response status and disallow redirect following", async () => {
    environment.INDEXER_URL = "https://indexer.probabl.test";
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      expect(init?.headers).toBeUndefined();
      return Response.json({ error: "missing" }, { status: 404 });
    }) as typeof fetch;
    const response = await indexerGet(
      new NextRequest("https://ui.test/api/indexer/markets"),
      context(["markets"]),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});

test("indexer redirects fail closed without following or forwarding a location", async () => {
  environment.INDEXER_URL = "https://indexer.probabl.test";
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(null, {
      status: 302,
      headers: { location: "https://attacker.invalid" },
    });
  }) as unknown as typeof fetch;
  const response = await indexerGet(
    new NextRequest("https://ui.test/api/indexer/markets"),
    context(["markets"]),
  );
  expect(response.status).toBe(503);
  expect(response.headers.has("location")).toBe(false);
  expect(calls).toBe(1);
});

const valid = {
  NEXT_PUBLIC_APP_URL: "https://probabl-ui.account.workers.dev",
  NEXT_PUBLIC_ROBINHOOD_RPC_URL: "https://rpc.robinhoodchain.com",
  NEXT_PUBLIC_BLOCK_EXPLORER_URL: "https://explorer.robinhoodchain.com",
  NEXT_PUBLIC_POLYMARKET_STREAM_URL: "wss://stream.probabl.com",
  NEXT_PUBLIC_ROBINHOOD_CHAIN_ID: "4663",
  NEXT_PUBLIC_ROBINHOOD_CHAIN_NAME: "Robinhood Chain",
  NEXT_PUBLIC_CONDITIONAL_TOKENS_ADDRESS:
    "0x1111111111111111111111111111111111111111",
  NEXT_PUBLIC_EXCHANGE_ADDRESS: "0x2222222222222222222222222222222222222222",
  NEXT_PUBLIC_ATOMIC_ORDER_ROUTER_ADDRESS:
    "0x3333333333333333333333333333333333333333",
  NEXT_PUBLIC_PAYOUT_VAULT_ADDRESS:
    "0x4444444444444444444444444444444444444444",
  NEXT_PUBLIC_POSITION_ROUTER_ADDRESS:
    "0x5555555555555555555555555555555555555555",
};
describe("Workers deployment guard", () => {
  test("default deployment skips env checks; strict deployment remains opt-in", async () => {
    const app = (await Bun.file(
      new URL("../package.json", import.meta.url),
    ).json()) as {
      scripts: Record<string, string>;
    };
    const root = (await Bun.file(
      new URL("../../../package.json", import.meta.url),
    ).json()) as {
      scripts: Record<string, string>;
    };
    expect(root.scripts["deploy:ui:cloudflare"]).toBe(
      "bun --filter @conditional-stocks/web deploy:cloudflare",
    );
    expect(app.scripts["deploy:cloudflare"]).toBe(
      "bun run build:cloudflare && opennextjs-cloudflare deploy",
    );
    expect(app.scripts["build:cloudflare"]).toContain(
      "&& bun scripts/cloudflare-sanitize.ts",
    );
    expect(root.scripts["deploy:ui:cloudflare:strict"]).toBe(
      "bun --filter @conditional-stocks/web deploy:cloudflare:strict",
    );
    expect(app.scripts["deploy:cloudflare:strict"]).toBe(
      "bun run check:cloudflare && bun run deploy:cloudflare",
    );
  });
  test("accepts complete public settings; runtime credentials are not build requirements", () => {
    expect(validateCloudflareEnvironment(valid)).toEqual([]);
    expect(validateCloudflareEnvironment({})).toHaveLength(
      Object.keys(valid).length,
    );
  });
  test("rejects every missing required setting", () => {
    for (const key of Object.keys(valid))
      expect(
        validateCloudflareEnvironment({ ...valid, [key]: "" }).length,
      ).toBeGreaterThan(0);
  });
  test("rejects local/placeholder URLs, insecure sockets, and invalid chain/address settings", () => {
    for (const [key, value] of [
      ["NEXT_PUBLIC_APP_URL", "https://localhost"],
      ["NEXT_PUBLIC_APP_URL", "https://127.0.0.1"],
      ["NEXT_PUBLIC_APP_URL", "https://192.168.1.1"],
      ["NEXT_PUBLIC_APP_URL", "https://app.example.com"],
      ["NEXT_PUBLIC_APP_URL", "https://app.probabl.com/path"],
      ["NEXT_PUBLIC_APP_URL", "https://user:secret@app.probabl.com"],
      ["NEXT_PUBLIC_POLYMARKET_STREAM_URL", "ws://stream.probabl.com"],
      [
        "NEXT_PUBLIC_POLYMARKET_STREAM_URL",
        "wss://stream.probabl.com/already/path",
      ],
      ["NEXT_PUBLIC_ROBINHOOD_CHAIN_ID", "31337"],
      ["NEXT_PUBLIC_ROBINHOOD_CHAIN_ID", "NaN"],
      [
        "NEXT_PUBLIC_EXCHANGE_ADDRESS",
        "0x0000000000000000000000000000000000000000",
      ],
      ["NEXT_PUBLIC_CONDITIONAL_TOKENS_ADDRESS", "not-an-address"],
      ["NEXT_PUBLIC_LOG_LEVEL", "trace"],
    ]) {
      expect(
        validateCloudflareEnvironment({ ...valid, [key as string]: value })
          .length,
      ).toBeGreaterThan(0);
    }
  });
  test("sanitized environment cannot provide local or backend-secret fallbacks", () => {
    expect(sanitizedEnvironmentModule).toBe(
      "export const production = {};\nexport const development = {};\nexport const test = {};\n",
    );
  });
});
