// Intentionally never reads deployment keypairs or devnet environment files.
const rpc = process.env.SOLANA_POOL_TEST_RPC;
if (!rpc || !["localhost", "127.0.0.1"].includes(new URL(rpc).hostname))
  throw new Error(
    "Set SOLANA_POOL_TEST_RPC to a disposable localhost validator running the freshly built program",
  );

const child = Bun.spawn(["bun", "test", "packages/solana-client/test/pool-validator.test.ts"], {
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env, SOLANA_POOL_TEST_RPC: rpc },
});
if (await child.exited) throw new Error("Protocol-wide custody validator tests failed");

export {};
