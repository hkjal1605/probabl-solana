/** Explicitly journal mainnet broadcasts before submission; never record signed payloads or keys. */
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { type Hex, keccak256 } from "viem";
import { createChainClients, loadArtifact, loadConditionalTokensArtifact } from "./lib.ts";

const { account, chainId, publicClient } = await createChainClients("DEPLOYER_PRIVATE_KEY");
const expectedNonce = Number(process.env.DEPLOYMENT_EXPECTED_NONCE);
if (!Number.isSafeInteger(expectedNonce) || expectedNonce < 0)
  throw new Error("DEPLOYMENT_EXPECTED_NONCE must explicitly identify this deployment");
const nonce = await publicClient.getTransactionCount({
  address: account.address,
  blockTag: "pending",
});
if (nonce !== expectedNonce)
  throw new Error("Deployer nonce changed; inspect existing transactions before retrying");
await loadConditionalTokensArtifact();
for (const name of [
  "ProtocolAuthority",
  "MarketRegistry",
  "ManualResolutionController",
  "ConditionalExchange",
  "OrderValidator",
  "PayoutVault",
  "ProtocolFeeVault",
  "ConditionalSettlement",
  "AtomicOrderRouter",
  "OrderRecoveryRouter",
  "PositionRouter",
])
  await loadArtifact(name);
const directory = resolve(
  process.env.DEPLOYMENT_OUTPUT_DIRECTORY ?? `packages/contracts/deployments/${chainId}`,
);
mkdirSync(directory, { recursive: true });
const journal = resolve(
  directory,
  `deployment-${account.address.toLowerCase()}-nonce${nonce}.jsonl`,
);
const descriptor = openSync(journal, "wx", 0o600);
const record = (value: unknown) => {
  appendFileSync(descriptor, `${JSON.stringify(value)}\n`);
  fsyncSync(descriptor);
};
record({
  event: "started",
  chainId,
  deployer: account.address,
  nonce,
  at: new Date().toISOString(),
});
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (...args: Parameters<typeof fetch>) => {
    const body = args[1]?.body;
    if (typeof body === "string") {
      const payload = JSON.parse(body);
      const requests = Array.isArray(payload) ? payload : [payload];
      for (const request of requests) {
        if (request.method === "eth_sendRawTransaction") {
          const hash = keccak256(request.params[0] as Hex);
          record({ event: "broadcast", transactionHash: hash, at: new Date().toISOString() });
          console.info(JSON.stringify({ event: "deployment.broadcast", transactionHash: hash }));
        }
      }
    }
    return originalFetch(...args);
  },
  { preconnect: originalFetch.preconnect },
);
try {
  await import("./deploy-v1.ts");
  record({ event: "completed", at: new Date().toISOString() });
} catch (error) {
  record({ event: "failed", at: new Date().toISOString() });
  // Third-party RPC errors can include authenticated URLs and signed transactions.
  const message = error instanceof Error ? error.message : "Unknown deployment error";
  console.error(
    message
      .replace(/https?:\/\/[^\s"']+/g, "[REDACTED_RPC_URL]")
      .replace(/0x[0-9a-fA-F]{64,}/g, "[REDACTED_HEX]"),
  );
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
  closeSync(descriptor);
}
