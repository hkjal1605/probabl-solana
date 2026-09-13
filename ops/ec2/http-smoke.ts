/** Non-mutating HTTP route checks. A blocked readiness gate is reported, not bypassed. */
const origin = process.argv[2] ?? "http://127.0.0.1";
const checks: [string, number[]][] = [
  ["/health", [200]],
  ["/v1", [200]],
  ["/ready", [200, 503]],
  ["/v1/system/readiness", [200, 503]],
  ["/markets", [200, 400, 503]],
  ["/.env", [404]],
  ["/internal/reconciliation-snapshot", [404]],
  ["/internal/match-candidates", [404]],
  ["/metrics", [404]],
  ["/sql", [404]],
  ["/graphql", [404]],
];
let failed = false;
for (const [path, allowed] of checks) {
  const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(15_000) });
  const body = await response.text();
  const passed = allowed.includes(response.status);
  failed ||= !passed;
  console.log(
    JSON.stringify({
      path,
      status: response.status,
      passed,
      ...(path === "/ready" ? { tradingReady: response.status === 200 } : {}),
      ...(path === "/health" || path === "/ready" ? { body } : {}),
    }),
  );
}
const invalidOrder = await fetch(`${origin}/v1/orders/prepare`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
  signal: AbortSignal.timeout(15_000),
});
await invalidOrder.body?.cancel();
failed ||= invalidOrder.status !== 401;
console.log(
  JSON.stringify({
    path: "/v1/orders/prepare",
    authenticated: false,
    status: invalidOrder.status,
    passed: invalidOrder.status === 401,
  }),
);
const indexedWrite = await fetch(`${origin}/markets`, {
  method: "POST",
  body: "{}",
  signal: AbortSignal.timeout(15_000),
});
await indexedWrite.body?.cancel();
failed ||= indexedWrite.status !== 403;
console.log(
  JSON.stringify({
    path: "/markets",
    method: "POST",
    status: indexedWrite.status,
    passed: indexedWrite.status === 403,
  }),
);
if (failed) process.exitCode = 1;
