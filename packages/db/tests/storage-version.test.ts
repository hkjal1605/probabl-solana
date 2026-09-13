import { expect, test } from "bun:test";
import { createDatabase } from "../src/connection.ts";
import { testDatabase } from "../src/testing.ts";

test("deployment identity is immutable and rejects another chain or exchange without rescaling state", async () => {
  const fixture = await testDatabase();
  for (const identity of [
    { chainId: 1, exchange: "0x1000000000000000000000000000000000000001" as const },
    { chainId: 31337, exchange: "0x2000000000000000000000000000000000000002" as const },
  ]) {
    const other = createDatabase({ connectionString: fixture.connectionString, ...identity });
    try {
      await expect(other.verify()).rejects.toThrow("deployment mismatch");
    } finally {
      await other.close();
    }
  }
  await fixture.database.migrate();
  await fixture.database.verify();
});
