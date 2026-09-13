import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizedEnvironmentModule } from "./cloudflare-sanitize";

// Real workerd integration, with owned loopback upstreams only. No wallet,
// Cloudflare account, production service, database or chain access is required.
const directory = fileURLToPath(new URL("..", import.meta.url));
assert.equal(
  await readFile(join(directory, ".open-next/cloudflare/next-env.mjs"), "utf8"),
  sanitizedEnvironmentModule,
  "Build must sanitize the adapter's environment module before preview/deploy",
);
const stateDirectory = await mkdtemp(join(tmpdir(), "probabl-ui-worker-"));
const marker = crypto.randomUUID();
let upstreamCalls = 0;
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    upstreamCalls++;
    const url = new URL(request.url);
    if (url.pathname === "/markets/redirect")
      return new Response(null, { status: 302, headers: { location: "https://attacker.invalid" } });
    if (url.pathname === "/v1/orders" && request.method === "POST")
      return Response.json(
        {
          marker,
          body: await request.text(),
          auth: request.headers.get("authorization"),
          idempotency: request.headers.get("idempotency-key"),
          cookie: request.headers.get("cookie"),
        },
        { status: 201 },
      );
    return Response.json({ marker, markets: [], path: url.pathname, search: url.search });
  },
});
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = probe.port;
await probe.stop(true);
assert(port !== undefined);
const origin = `http://127.0.0.1:${port}`;
const worker = Bun.spawn(
  [
    "bun",
    "x",
    "--no-install",
    "wrangler",
    "dev",
    "--local",
    "--port",
    String(port),
    "--inspector-port",
    "0",
    "--persist-to",
    stateDirectory,
    "--var",
    "PROBABL_HOSTING:local",
    "--var",
    `API_URL:http://127.0.0.1:${upstream.port}`,
    "--var",
    `INDEXER_URL:http://127.0.0.1:${upstream.port}`,
  ],
  {
    cwd: directory,
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_LOG_PATH: join(stateDirectory, "logs"),
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    },
    stdout: "pipe",
    stderr: "pipe",
  },
);
const output = new Response(worker.stdout).text();
const errors = new Response(worker.stderr).text();
let checks = 0;
let completed = false;
const request = (path: string, init?: RequestInit) =>
  fetch(`${origin}${path}`, { ...init, redirect: "manual", signal: AbortSignal.timeout(15_000) });
try {
  const deadline = Date.now() + 45_000;
  while (true) {
    try {
      const response = await request("/api/indexer/markets");
      const body = (await response.json()) as { marker?: string };
      assert.equal(body.marker, marker);
      checks++;
      break;
    } catch (error) {
      if (Date.now() > deadline || typeof worker.exitCode === "number") throw error;
      await Bun.sleep(300);
    }
  }
  for (const path of [
    "/",
    "/markets",
    `/markets/0x${"1".repeat(64)}`,
    "/orders",
    "/portfolio",
    "/funds",
    "/resolution",
    "/learn",
  ]) {
    const callsBefore = upstreamCalls;
    const response = await request(path, { headers: { cookie: "probabl-mode=demo" } });
    assert.equal(response.status, 200, path);
    const html = await response.text();
    assert(html.includes("probabl"), path);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert(
      response.headers.get("cache-control")?.includes("no-store"),
      `${path} must not be cached`,
    );
    assert.equal(upstreamCalls, callsBefore, `${path} demo SSR must never read real upstreams`);
    checks++;
  }
  const live = await request("/markets");
  assert.equal(live.status, 200);
  const html = await live.text();
  const assetPath = html.match(/src="([^" ]*\/_next\/static\/[^" ]+\.js)"/)?.[1];
  assert(assetPath, "SSR must link a JavaScript asset");
  const asset = await request(assetPath);
  assert.equal(asset.status, 200);
  assert(asset.headers.get("cache-control")?.includes("immutable"));
  checks += 2;
  const cssPath = html.match(/href="([^" ]*\/_next\/static\/[^" ]+\.css)"/)?.[1];
  assert(cssPath, "SSR must link a stylesheet");
  const css = await request(cssPath);
  assert.equal(css.status, 200);
  assert(css.headers.get("cache-control")?.includes("immutable"));
  checks++;
  const logo = await request("/brand/logo-name.svg");
  assert.equal(logo.status, 200);
  assert((await logo.text()).includes("<svg"));
  checks++;

  for (const path of ["/api/gateway/markets", "/api/indexer/markets"]) {
    const callsBefore = upstreamCalls;
    const response = await request(path, { headers: { cookie: "probabl-mode=demo" } });
    assert.equal(response.status, 409);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(upstreamCalls, callsBefore);
    checks++;
  }
  const body = '{"amount":"9007199254740993123456789"}';
  const order = await request("/api/gateway/orders", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer local-smoke",
      "idempotency-key": "worker-smoke",
      cookie: "private=not-forwarded",
    },
    body,
  });
  assert.equal(order.status, 201);
  assert.equal(order.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await order.json(), {
    marker,
    body,
    auth: "Bearer local-smoke",
    idempotency: "worker-smoke",
    cookie: null,
  });
  checks++;
  const forbidden = await request("/api/indexer/internal");
  assert.equal(forbidden.status, 404);
  checks++;
  const redirect = await request("/api/indexer/markets/redirect");
  assert.equal(redirect.status, 503);
  assert.equal(redirect.headers.get("location"), null);
  checks++;
  const mode = await request("/api/mode", {
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: "mode=demo&returnTo=/markets",
  });
  assert.equal(mode.status, 303);
  assert.equal(mode.headers.get("location"), "/markets");
  assert(mode.headers.get("set-cookie")?.includes("probabl-mode=demo"));
  checks++;
  const callsBeforeSwitch = upstreamCalls;
  const afterSwitch = await request("/markets", {
    headers: { cookie: mode.headers.get("set-cookie")?.split(";")[0] ?? "" },
  });
  assert.equal(afterSwitch.status, 200);
  await afterSwitch.text();
  assert.equal(upstreamCalls, callsBeforeSwitch);
  checks++;
  const crossOrigin = await request("/api/mode", {
    method: "POST",
    headers: {
      origin: "https://attacker.invalid",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "mode=demo",
  });
  assert.equal(crossOrigin.status, 403);
  checks++;
  completed = true;
  console.info(
    `Cloudflare workerd smoke: ${checks} checks passed (owned loopback upstreams only).`,
  );
} finally {
  worker.kill("SIGTERM");
  await worker.exited;
  await upstream.stop(true);
  const logs = `${await output}\n${await errors}`;
  await writeFile(join(stateDirectory, "runtime.log"), logs, { mode: 0o600 });
  // Logs contain only this test's loopback settings. Avoid dumping any local bindings.
  if (!completed)
    console.error(`Worker smoke incomplete; inspect Wrangler logs in ${stateDirectory}`);
  assert(!logs.includes("Uncaught"), "Worker emitted an uncaught runtime exception");
}
