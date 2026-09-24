import { describe, expect, test } from "bun:test";
import { validateCloudflareEnvironment } from "../scripts/cloudflare-preflight";
import { sanitizedEnvironmentModule } from "../scripts/cloudflare-sanitize";

const valid = {
  NEXT_PUBLIC_APP_URL: "https://probabl-ui.account.workers.dev",
  NEXT_PUBLIC_API_URL: "https://api-solana.probabl.trade",
  NEXT_PUBLIC_SOLANA_RPC_URL: "https://api.devnet.solana.com",
  NEXT_PUBLIC_SOLANA_GENESIS_HASH: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  NEXT_PUBLIC_SOLANA_PROGRAM_ID: "53gtyz9nYzS7vwSbx2v7GeGLrMTas7vCATkjiKvAG1ra",
  NEXT_PUBLIC_SOLANA_CONFIG: "EfXom6mQxuw5gsHG4AujCgo1dQ3qWg5pN85RvY1ysn23",
  NEXT_PUBLIC_SOLANA_ADDRESS_LOOKUP_TABLES:
    "4jotxTZdn4GnN5PgmeVwT3oB5YxPDBNBVgdrNyCTMiqk,8t9QCxN9TVJtSu9BFaSQWzdEiPFm13nEaU9cJ7zmLDiM",
};
describe("Workers deployment guard", () => {
  test("default deployment skips env checks; strict deployment remains opt-in", async () => {
    const app = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
      scripts: Record<string, string>;
    };
    const root = (await Bun.file(new URL("../../../package.json", import.meta.url)).json()) as {
      scripts: Record<string, string>;
    };
    expect(root.scripts["deploy:ui:cloudflare"]).toBe(
      "bun --filter @conditional-stocks/web deploy:cloudflare",
    );
    expect(app.scripts["deploy:cloudflare"]).toBe(
      "bun run build:cloudflare && opennextjs-cloudflare deploy",
    );
    expect(app.scripts["build:cloudflare"]).toContain("&& bun scripts/cloudflare-sanitize.ts");
    expect(root.scripts["deploy:ui:cloudflare:strict"]).toBe(
      "bun --filter @conditional-stocks/web deploy:cloudflare:strict",
    );
    expect(app.scripts["deploy:cloudflare:strict"]).toBe(
      "bun run check:cloudflare && bun run deploy:cloudflare",
    );
  });
  test("accepts complete public settings; runtime credentials are not build requirements", () => {
    expect(validateCloudflareEnvironment(valid)).toEqual([]);
    expect(validateCloudflareEnvironment({})).toHaveLength(Object.keys(valid).length);
  });
  test("rejects every missing required setting", () => {
    for (const key of Object.keys(valid))
      expect(validateCloudflareEnvironment({ ...valid, [key]: "" }).length).toBeGreaterThan(0);
  });
  test("rejects local/placeholder URLs and invalid Solana deployment settings", () => {
    for (const [key, value] of [
      ["NEXT_PUBLIC_APP_URL", "https://localhost"],
      ["NEXT_PUBLIC_APP_URL", "https://127.0.0.1"],
      ["NEXT_PUBLIC_APP_URL", "https://192.168.1.1"],
      ["NEXT_PUBLIC_APP_URL", "https://app.example.com"],
      ["NEXT_PUBLIC_APP_URL", "https://app.probabl.com/path"],
      ["NEXT_PUBLIC_APP_URL", "https://user:secret@app.probabl.com"],
      ["NEXT_PUBLIC_API_URL", "http://api-solana.probabl.trade"],
      ["NEXT_PUBLIC_API_URL", "https://api-solana.probabl.trade/path"],
      ["NEXT_PUBLIC_SOLANA_RPC_URL", "http://api.devnet.solana.com"],
      ["NEXT_PUBLIC_SOLANA_PROGRAM_ID", "not-an-address"],
      ["NEXT_PUBLIC_SOLANA_PROGRAM_ID", "CxMFWB9ZYJbHd56NB1nEaM71YKcgKfpEZwgDxJRLbbA3"],
      ["NEXT_PUBLIC_SOLANA_CONFIG", "11111111111111111111111111111111"],
      ["NEXT_PUBLIC_SOLANA_ADDRESS_LOOKUP_TABLES", "not-an-address"],
      [
        "NEXT_PUBLIC_SOLANA_ADDRESS_LOOKUP_TABLES",
        "4jotxTZdn4GnN5PgmeVwT3oB5YxPDBNBVgdrNyCTMiqk,4jotxTZdn4GnN5PgmeVwT3oB5YxPDBNBVgdrNyCTMiqk",
      ],
      ["NEXT_PUBLIC_LOG_LEVEL", "trace"],
    ]) {
      expect(
        validateCloudflareEnvironment({ ...valid, [key as string]: value }).length,
      ).toBeGreaterThan(0);
    }
  });
  test("sanitized environment cannot provide local or backend-secret fallbacks", () => {
    expect(sanitizedEnvironmentModule).toBe(
      "export const production = {};\nexport const development = {};\nexport const test = {};\n",
    );
  });
});
