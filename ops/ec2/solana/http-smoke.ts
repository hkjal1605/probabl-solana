/** No on-chain writes. --auth creates one short-lived test login for an unfunded, ephemeral wallet. */
import assert from "node:assert/strict";
import { createPrivateKey, sign } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const origin = new URL(process.argv[2] ?? "https://api-solana.probabl.trade")
  .origin;
if (origin === "https://api-solana.probabl.trade") {
  const redirect = await fetch(
    "http://api-solana.probabl.trade/ready?probe=redirect",
    {
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
    },
  );
  assert.equal(redirect.status, 308);
  assert.equal(
    redirect.headers.get("location"),
    `${origin}/ready?probe=redirect`,
  );
  await redirect.body?.cancel();
  const acme = await fetch(
    "http://api-solana.probabl.trade/.well-known/acme-challenge/probabl-readiness",
    {
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
    },
  );
  assert.equal(acme.status, 200);
  assert.equal((await acme.text()).trim(), "probabl-solana-acme-webroot-ready");
  console.log(JSON.stringify({ httpsRedirect: true, acmeRenewalPath: true }));
}
const request = (path: string, init?: RequestInit) =>
  fetch(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(20_000) });
const checks: [string, number][] = [
  ["/health", 200],
  ["/ready", 200],
  ["/v1/system/readiness", 200],
  ["/indexer-health", 200],
  ["/polymarket-health", 200],
  ["/markets", 200],
  ["/orderbooks", 200],
  ["/orders", 200],
  ["/trades", 200],
  ["/.env", 404],
  ["/.local/ec2/env/api.env", 404],
  ["/internal/subscriptions", 404],
  ["/reconciliation", 404],
  ["/metrics", 404],
  ["/sql", 404],
  ["/graphql", 404],
];
for (const [path, status] of checks) {
  const response = await request(path);
  assert.equal(response.status, status, `${path} status`);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  if (origin.startsWith("https:"))
    assert.equal(
      response.headers.get("strict-transport-security"),
      "max-age=31536000",
    );
  if (path === "/ready")
    assert.equal(
      ((await response.json()) as { healthy: boolean }).healthy,
      true,
    );
  else if (path === "/indexer-health") {
    const body = (await response.json()) as {
      healthy: boolean;
      head: { finalizedBlock: string };
    };
    assert.equal(body.healthy, true);
    assert(BigInt(body.head.finalizedBlock) > 0n);
  } else await response.body?.cancel();
  console.log(JSON.stringify({ path, status, passed: true }));
}
for (const [path, status] of [
  ["/v1/orders/prepare", 401],
  ["/markets", 403],
] as const) {
  const response = await request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, status, `${path} unauthenticated POST`);
  await response.body?.cancel();
  console.log(JSON.stringify({ path, method: "POST", status, passed: true }));
}
if (process.argv.includes("--auth")) {
  const wallet = Keypair.generate();
  const address = wallet.publicKey.toBase58();
  const post = (path: string, body: unknown) =>
    request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const rejectedOrigin = await post("/v1/auth/challenge", {
    address,
    origin: "https://untrusted.invalid",
  });
  assert.equal(rejectedOrigin.status, 403);
  await rejectedOrigin.body?.cancel();
  const issued = await post("/v1/auth/challenge", {
    address,
    origin: "http://localhost:3001",
  });
  assert.equal(issued.status, 200);
  const { challengeId, message } = (await issued.json()) as {
    challengeId: string;
    message: string;
  };
  assert(message.includes("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"));
  assert(message.includes("A7t71Mf3PbBuvD8jKXCYQxd9oxrf2woLf3kWszT14mxe"));
  const signingKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(wallet.secretKey.subarray(0, 32)),
    ]),
    format: "der",
    type: "pkcs8",
  });
  const proof = {
    address,
    challengeId,
    signature: bs58.encode(sign(null, Buffer.from(message), signingKey)),
  };
  const signedIn = await post("/v1/auth/verify", proof);
  assert.equal(signedIn.status, 200);
  const { token } = (await signedIn.json()) as { token: string };
  assert.match(token, /^[a-f0-9]{64}$/);
  const replay = await post("/v1/auth/verify", proof);
  assert.equal(replay.status, 400);
  await replay.body?.cancel();
  const forbiddenAdmin = await request("/v1/admin/evidence", {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(forbiddenAdmin.status, 403);
  await forbiddenAdmin.body?.cancel();
  console.log(
    JSON.stringify({
      auth: "signed challenge, replay rejection, origin and admin authorization",
      passed: true,
      onChainWrites: false,
    }),
  );
}
