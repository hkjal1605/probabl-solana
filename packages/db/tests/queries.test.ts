import { expect, test } from "bun:test";
import { testDatabase } from "@conditional-stocks/db/testing";
import { createEvidenceQueries } from "../src/evidence/queries.ts";
import { createGatewayQueries } from "../src/gateway/queries.ts";
import { createPolymarketQueries } from "../src/polymarket/queries.ts";
import { createReconciliationQueries } from "../src/reconciliation/queries.ts";

test("query factories expose named functions, not raw connections, and support destructuring", async () => {
  for (const create of [
    createGatewayQueries,
    createEvidenceQueries,
    createReconciliationQueries,
    createPolymarketQueries,
  ]) {
    const queries = create((await testDatabase()).database);
    try {
      expect(Object.values(queries).every((value) => typeof value === "function")).toBe(true);
      for (const name of ["db", "database", "query", "exec", "run", "transaction", "migrate"])
        expect(queries).not.toHaveProperty(name);
    } finally {
      const { close } = queries;
      await close();
    }
  }
  const { saveChallenge, consumeChallenge, close } = createGatewayQueries(
    (await testDatabase()).database,
  );
  try {
    const maker = "0x1000000000000000000000000000000000000001";
    await saveChallenge("one", maker, "test challenge", 2000n);
    expect(await consumeChallenge("one", maker, 1000n)).toBe("test challenge");
    expect(await consumeChallenge("one", maker, 1000n)).toBeNull();
  } finally {
    await close();
  }
});
