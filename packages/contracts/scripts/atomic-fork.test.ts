import { expect, test } from "bun:test";
import { testDatabase } from "@conditional-stocks/db/testing";

// Explicit opt-in: this test reads RH archive state through the runner's deny-write proxy.
// All signing and balance changes remain on its owned loopback Anvil fork.
test.skipIf(process.env.RUN_ATOMIC_FORK !== "1")(
  "real USDG/NVDA/TSLA atomic full stack and 48 redemption lifecycles",
  async () => {
    // The fork deploys a fresh random exchange; its lifecycle owns deployment identity setup.
    const fixture = await testDatabase({ migrate: false });
    const child = Bun.spawn(
      ["bun", "--no-env-file", new URL("test-rh-token-fork.ts", import.meta.url).pathname],
      {
        env: {
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
          DATABASE_URL: fixture.connectionString,
          PONDER_TELEMETRY_DISABLED: "true",
          DO_NOT_TRACK: "1",
        },
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    try {
      expect(await child.exited).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      await child.exited;
    }
  },
  900_000,
);
