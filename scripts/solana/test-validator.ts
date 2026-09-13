const rpc = process.env.SOLANA_TEST_RPC ?? process.env.SOLANA_RPC_URL;
if (
  !rpc ||
  !["localhost", "127.0.0.1", "[::1]"].includes(new URL(rpc).hostname)
) {
  throw new Error(
    "Validator tests require an explicitly configured localhost RPC; they mint mock assets and spend test SOL",
  );
}
const child = Bun.spawn(
  [
    process.execPath,
    "test",
    "packages/solana-client/test/local-validator.test.ts",
    "packages/solana-client/test/token2022-validator.test.ts",
  ],
  {
    env: { ...process.env, SOLANA_TEST_RPC: rpc },
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exit(await child.exited);
