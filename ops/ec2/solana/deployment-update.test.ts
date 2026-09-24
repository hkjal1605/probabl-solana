import { expect, test } from "bun:test";
import { parseEnv } from "node:util";
import { nextEnvironment, replaceSettings } from "./update-deployment";

const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

test("a deployment update sets the reviewed identity and requested settings only", () => {
  const before = `# operator comment\nSOLANA_GENESIS_HASH="${GENESIS}"\nDATABASE_URL="postgresql://test:fake-password@example/db"\nSOLANA_PROGRAM_ID="Old1111111111111111111111111111111111111111"\nSOLANA_CONFIG="Old2222222222222222222222222222222222222222"\nJUPITER_API_KEY="fake-test-key"\n`;
  const next = nextEnvironment("api", before, {
    INDEXER_RELAY_URL: "http://127.0.0.1:42070",
    SOLANA_ISSUER_REPLICA_MINTS: "NVDAx=So11111111111111111111111111111111111111112",
  });
  expect(parseEnv(next)).toEqual({
    ...parseEnv(before),
    SOLANA_PROGRAM_ID: "53gtyz9nYzS7vwSbx2v7GeGLrMTas7vCATkjiKvAG1ra",
    SOLANA_CONFIG: "EfXom6mQxuw5gsHG4AujCgo1dQ3qWg5pN85RvY1ysn23",
    INDEXER_RELAY_URL: "http://127.0.0.1:42070",
    SOLANA_ISSUER_REPLICA_MINTS: "NVDAx=So11111111111111111111111111111111111111112",
  });
  expect(next).toContain("# operator comment");
  // The market maker uses its own identity names.
  const mm = parseEnv(nextEnvironment("market-maker", `MM_GENESIS_HASH="${GENESIS}"\nMM_PRIVATE_KEY="fake"\n`));
  expect([mm.MM_PROGRAM_ID, mm.MM_SOLANA_CONFIG, mm.MM_PRIVATE_KEY]).toEqual([
    "53gtyz9nYzS7vwSbx2v7GeGLrMTas7vCATkjiKvAG1ra",
    "EfXom6mQxuw5gsHG4AujCgo1dQ3qWg5pN85RvY1ysn23",
    "fake",
  ]);
});

test("unlisted, credential-bearing or multi-line settings and other networks fail", () => {
  const before = `SOLANA_GENESIS_HASH="${GENESIS}"\nDATABASE_URL="postgresql://a:b@c/d"\n`;
  expect(() => nextEnvironment("api", before, { DATABASE_URL: "postgresql://x" })).toThrow("not a deployment setting");
  expect(() => nextEnvironment("polymarket", before, { YELLOWSTONE_X_TOKEN: "t" })).toThrow("not a deployment setting");
  expect(() => nextEnvironment("indexer", before, { YELLOWSTONE_X_TOKEN: "a\nDATABASE_URL=x" })).toThrow("single line");
  expect(() => nextEnvironment("indexer", before, { YELLOWSTONE_GRPC_URL: "https://user:pw@example" })).toThrow("without credentials");
  expect(() => nextEnvironment("api", 'SOLANA_GENESIS_HASH="other"\n')).toThrow("Unexpected Solana network");
  expect(replaceSettings("A=1\n", { B: "" }, ["B"])).toBe('A=1\nB=""\n');
});
