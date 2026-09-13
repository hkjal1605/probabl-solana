import { expect, test } from "bun:test";
import { parseEnv } from "node:util";
import { replaceRpcSetting } from "./update-rpc";
test("only RPC changes; database, authentication and pricing settings remain on server unchanged", () => {
  const before =
    '# operator comment\nDATABASE_URL="postgresql://test:fake-password@example/db"\nSOLANA_RPC_URL="https://old.example"\nAPI_AUTH_ORIGINS="http://localhost:3001"\nJUPITER_API_KEY="fake-test-key"\nJUPITER_PRICE_RPC_URL="https://mainnet.example"\n';
  const next = replaceRpcSetting(before, "https://devnet.example/?api-key=test-only");
  expect(parseEnv(next)).toEqual({
    ...parseEnv(before),
    SOLANA_RPC_URL: "https://devnet.example/?api-key=test-only",
  });
  expect(next).toContain("# operator comment");
});
test("ambiguous RPC values and missing prior settings fail without changing the input", () => {
  const before = 'SOLANA_RPC_URL="https://old.example"\n';
  for (const rpc of [
    "http://insecure.example",
    "https://user:secret@example",
    "https://rpc.example/#fragment",
    "https://rpc.example/?key=$OTHER",
    "https://rpc.example/\nKEY=bad",
  ])
    expect(() => replaceRpcSetting(before, rpc)).toThrow();
  expect(() => replaceRpcSetting("A=1\n", "https://devnet.example")).toThrow("Existing");
});
