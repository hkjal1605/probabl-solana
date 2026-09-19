// No deployment env/key files. A localhost validator must load the fresh build.
const rpc = process.env.SOLANA_DELEGATION_TEST_RPC;
if (!rpc || !["localhost", "127.0.0.1"].includes(new URL(rpc).hostname))
  throw new Error(
    "Set SOLANA_DELEGATION_TEST_RPC to a disposable localhost validator running the fresh program",
  );
const child = Bun.spawn(
  ["bun", "test", "packages/solana-client/test/delegation-validator.test.ts"],
  {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, SOLANA_DELEGATION_TEST_RPC: rpc },
  },
);
if (await child.exited) throw new Error("Trading delegation validator tests failed");
export {};
