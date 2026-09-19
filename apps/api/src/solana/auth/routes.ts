import { createHash, randomBytes } from "node:crypto";
import type { SolanaDatabase } from "@conditional-stocks/db/solana";
import { SignInCapacityError } from "@conditional-stocks/db/solana";
import { address, key, type SolanaClient } from "@conditional-stocks/solana-client";
import bs58 from "bs58";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import nacl from "tweetnacl";

export type Authenticate = (header: string | undefined) => Promise<string>;

export function mountAuthentication(
  app: Hono,
  db: SolanaDatabase,
  client: SolanaClient,
  domain: string,
  origins: readonly string[],
): Authenticate {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const random = () => randomBytes(32).toString("hex");
  const authenticate: Authenticate = async (header) => {
    if (!header || !/^Bearer [a-f0-9]{64}$/.test(header))
      throw new HTTPException(401, { message: "Sign in to continue" });
    const owner = await db.sessionOwner(domain, hash(header.slice(7)));
    if (!owner) throw new HTTPException(401, { message: "Session expired" });
    return owner;
  };

  app.post("/v1/auth/challenge", async (c) => {
    const body = await c.req.json();
    const owner = address(body.address);
    const id = random();
    const origin = body.origin;
    if (typeof origin !== "string" || !origins.includes(origin))
      throw new HTTPException(403, { message: "Sign-in origin is not authorized" });
    const message = `Sign in to probabl\nOrigin: ${origin}\nSolana genesis: ${client.deployment.genesisHash}\nProgram: ${client.program}\nConfig: ${client.config}\nWallet: ${owner}\nNonce: ${id}\nExpires: ${new Date(Date.now() + 120_000).toISOString()}`;
    try {
      await db.locked(`${domain}:authentication`, (tx) =>
        tx.createChallenge(domain, owner, id, message),
      );
    } catch (error) {
      if (error instanceof SignInCapacityError)
        throw new HTTPException(429, { message: error.message });
      throw error;
    }
    return c.json({ challengeId: id, message });
  });

  app.post("/v1/auth/verify", async (c) => {
    const body = await c.req.json();
    const owner = address(body.address);
    if (
      typeof body.challengeId !== "string" ||
      typeof body.signature !== "string" ||
      body.signature.length > 128
    )
      throw new Error("Invalid authentication proof");
    const message = await db.challenge(domain, owner, body.challengeId);
    if (!message) throw new Error("Challenge expired or consumed");
    const signature = bs58.decode(body.signature);
    if (
      signature.length !== 64 ||
      !nacl.sign.detached.verify(new TextEncoder().encode(message), signature, key(owner).toBytes())
    )
      throw new Error("Invalid signature");
    const token = random();
    const expiresAtMs = await db.locked(`${domain}:authentication`, (tx) =>
      tx.consumeChallenge(domain, owner, body.challengeId, hash(token)),
    );
    return c.json({ token, expiresAtMs });
  });

  return authenticate;
}
