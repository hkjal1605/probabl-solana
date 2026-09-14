import { describe, expect, test } from "bun:test";
import { validateCloudflareEnvironment } from "../scripts/cloudflare-preflight";
import { sanitizedEnvironmentModule } from "../scripts/cloudflare-sanitize";
const valid = {
  NEXT_PUBLIC_APP_URL: "https://probabl-ui.account.workers.dev",
  NEXT_PUBLIC_ROBINHOOD_RPC_URL: "https://rpc.robinhoodchain.com",
  NEXT_PUBLIC_BLOCK_EXPLORER_URL: "https://explorer.robinhoodchain.com",
  NEXT_PUBLIC_POLYMARKET_STREAM_URL: "wss://stream.probabl.com",
  NEXT_PUBLIC_ROBINHOOD_CHAIN_ID: "4663",
  NEXT_PUBLIC_ROBINHOOD_CHAIN_NAME: "Robinhood Chain",
  NEXT_PUBLIC_CONDITIONAL_TOKENS_ADDRESS:
    "0x1111111111111111111111111111111111111111",
  NEXT_PUBLIC_EXCHANGE_ADDRESS: "0x2222222222222222222222222222222222222222",
  NEXT_PUBLIC_ATOMIC_ORDER_ROUTER_ADDRESS:
    "0x3333333333333333333333333333333333333333",
  NEXT_PUBLIC_PAYOUT_VAULT_ADDRESS:
    "0x4444444444444444444444444444444444444444",
  NEXT_PUBLIC_POSITION_ROUTER_ADDRESS:
    "0x5555555555555555555555555555555555555555",
};
describe("Workers deployment guard", () => {
  test("default deployment skips env checks; strict deployment remains opt-in", async () => {
    const app = (await Bun.file(
      new URL("../package.json", import.meta.url),
    ).json()) as {
      scripts: Record<string, string>;
    };
    const root = (await Bun.file(
      new URL("../../../package.json", import.meta.url),
    ).json()) as {
      scripts: Record<string, string>;
    };
    expect(root.scripts["deploy:ui:cloudflare"]).toBe(
      "bun --filter @conditional-stocks/web deploy:cloudflare",
    );
    expect(app.scripts["deploy:cloudflare"]).toBe(
      "bun run build:cloudflare && opennextjs-cloudflare deploy",
    );
    expect(app.scripts["build:cloudflare"]).toContain(
      "&& bun scripts/cloudflare-sanitize.ts",
    );
    expect(root.scripts["deploy:ui:cloudflare:strict"]).toBe(
      "bun --filter @conditional-stocks/web deploy:cloudflare:strict",
    );
    expect(app.scripts["deploy:cloudflare:strict"]).toBe(
      "bun run check:cloudflare && bun run deploy:cloudflare",
    );
  });
  test("accepts complete public settings; runtime credentials are not build requirements", () => {
    expect(validateCloudflareEnvironment(valid)).toEqual([]);
    expect(validateCloudflareEnvironment({})).toHaveLength(
      Object.keys(valid).length,
    );
  });
  test("rejects every missing required setting", () => {
    for (const key of Object.keys(valid))
      expect(
        validateCloudflareEnvironment({ ...valid, [key]: "" }).length,
      ).toBeGreaterThan(0);
  });
  test("rejects local/placeholder URLs, insecure sockets, and invalid chain/address settings", () => {
    for (const [key, value] of [
      ["NEXT_PUBLIC_APP_URL", "https://localhost"],
      ["NEXT_PUBLIC_APP_URL", "https://127.0.0.1"],
      ["NEXT_PUBLIC_APP_URL", "https://192.168.1.1"],
      ["NEXT_PUBLIC_APP_URL", "https://app.example.com"],
      ["NEXT_PUBLIC_APP_URL", "https://app.probabl.com/path"],
      ["NEXT_PUBLIC_APP_URL", "https://user:secret@app.probabl.com"],
      ["NEXT_PUBLIC_POLYMARKET_STREAM_URL", "ws://stream.probabl.com"],
      [
        "NEXT_PUBLIC_POLYMARKET_STREAM_URL",
        "wss://stream.probabl.com/already/path",
      ],
      ["NEXT_PUBLIC_ROBINHOOD_CHAIN_ID", "31337"],
      ["NEXT_PUBLIC_ROBINHOOD_CHAIN_ID", "NaN"],
      [
        "NEXT_PUBLIC_EXCHANGE_ADDRESS",
        "0x0000000000000000000000000000000000000000",
      ],
      ["NEXT_PUBLIC_CONDITIONAL_TOKENS_ADDRESS", "not-an-address"],
      ["NEXT_PUBLIC_LOG_LEVEL", "trace"],
    ]) {
      expect(
        validateCloudflareEnvironment({ ...valid, [key as string]: value })
          .length,
      ).toBeGreaterThan(0);
    }
  });
  test("sanitized environment cannot provide local or backend-secret fallbacks", () => {
    expect(sanitizedEnvironmentModule).toBe(
      "export const production = {};\nexport const development = {};\nexport const test = {};\n",
    );
  });
});
