import { expect, test } from "bun:test";
import { bn, delegationAddress, SolanaClient } from "@conditional-stocks/solana-client";
import { Keypair, PublicKey } from "@solana/web3.js";
import { custodyFixture } from "../../../../services/solana-indexer/test/custody-fixture";
import { tradingPermission, tradingSigner } from "../../src/solana/trading/delegated-orders.ts";

test("dedicated signer validation withholds private key and refuses mismatched public key", () => {
  const key = Keypair.generate();
  const secret = JSON.stringify([...key.secretKey]);
  expect(tradingSigner(undefined, undefined)).toBeNull();
  expect(tradingSigner(secret, String(key.publicKey))?.publicKey.equals(key.publicKey)).toBe(true);
  expect(() => tradingSigner(secret, String(Keypair.generate().publicKey))).toThrow("matching");
  expect(() => tradingSigner("invalid", undefined)).toThrow("value withheld");
});

test("public permission reflects only an active protocol-wide grant for this owner and key", () => {
  const { s, owner, config } = custodyFixture();
  const signer = Keypair.generate();
  const client = new SolanaClient({
    rpcUrl: "http://127.0.0.1:8899",
    config: String(config),
    genesisHash: "test",
    programId: String(s.program),
  });
  const base = tradingPermission(s, client, signer, String(owner));
  expect(base.available).toBe(true);
  expect(base.active).toBe(false);
  expect(base.grant).toBeNull();
  s.traders.set(String(owner), { delegation_epoch: bn(0) } as any);
  const id = String(delegationAddress(config, owner, signer.publicKey, s.program));
  const grant = {
    config,
    owner,
    delegate: signer.publicKey,
    market: PublicKey.default,
    epoch: bn(0),
    expires_at: bn(BigInt(Math.floor(Date.now() / 1000) + 3600)),
    max_order_quote: bn(1000),
    remaining_quote: bn(10000),
    max_fee_bps: 100,
    permissions: 1,
    revoked: false,
    bump: 0,
  };
  if (!s.delegations) throw new Error("Delegation fixture is missing");
  s.delegations.set(id, grant);
  expect(tradingPermission(s, client, signer, String(owner)).active).toBe(true);
  grant.market = PublicKey.unique();
  expect(tradingPermission(s, client, signer, String(owner)).active).toBe(false);
  grant.market = PublicKey.default;
  grant.revoked = true;
  expect(tradingPermission(s, client, signer, String(owner)).active).toBe(false);
  grant.revoked = false;
  grant.remaining_quote = bn(0);
  expect(tradingPermission(s, client, signer, String(owner)).active).toBe(false);
});
