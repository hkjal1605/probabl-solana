import { expect, test } from "bun:test";
import { postgresClient } from "./postgres-fixture.ts";

test("atomic retirement migration refuses every pending legacy state and preserves unrelated data", async () => {
  const { client } = await postgresClient({ migrate: false });
  const migration = async (name: string) =>
    Bun.file(new URL(`../migrations/${name}.sql`, import.meta.url)).text();
  for (const name of [
    "0000_dashing_earthquake",
    "0001_immutable-evidence",
    "0002_evidence-attachment-links",
    "0003_chubby_rhino",
  ])
    await client.exec(await migration(name));
  await client.exec("INSERT INTO gateway.auth_sessions VALUES ('retained', 'wallet', 100, NULL)");
  const retirement = await migration("0004_bitter_gorgon");
  const fixtures = [
    {
      table: "matching.proposals",
      states: ["persisted", "submitted", "mined"],
      insert: "INSERT INTO matching.proposals VALUES ('fixture', 'book', $1, 0, '{}')",
    },
    {
      table: "settlement.batches",
      states: ["queued", "simulated", "submitted", "mined"],
      insert:
        "INSERT INTO settlement.batches(batch_id,status,payload_hash,payload) VALUES ('fixture', $1, 'hash', '{}')",
    },
    {
      table: "settlement.ioc_intents",
      states: ["waiting-match"],
      insert:
        "INSERT INTO settlement.ioc_intents(intent_id,status,payload) VALUES ('fixture', $1, '{}')",
    },
    {
      table: "gateway.operations",
      states: ["accepted", "prepared", "broadcast", "retryable", "submitted"],
      insert:
        "INSERT INTO gateway.operations(operation_id,address,kind,idempotency_key,request_digest,state,payload) VALUES ('fixture', 'wallet', 'order', 'idempotency', 'digest', $1, '{}')",
    },
  ];
  for (const fixture of fixtures)
    for (const state of fixture.states) {
      await client.query(fixture.insert, [state]);
      await expect(
        client.transaction((connection) => connection.query(retirement)),
      ).rejects.toThrow("Pending legacy orders");
      expect(
        (await client.query(`SELECT COUNT(*)::int AS count FROM ${fixture.table}`)).rows[0]?.count,
      ).toBe(1);
      expect(
        (await client.query("SELECT to_regclass('matching.events') IS NOT NULL AS retained"))
          .rows[0]?.retained,
      ).toBe(true);
      await client.exec(`DELETE FROM ${fixture.table}`);
    }
  // Terminal trading records may retire. Nontrading pending recovery outboxes must survive.
  for (const fixture of fixtures) await client.query(fixture.insert, ["failed"]);
  await client.exec("UPDATE gateway.operations SET kind = 'cancel', state = 'prepared'");
  await client.transaction((connection) => connection.query(retirement));
  await client.exec(await migration("0005_spotty_silverclaw"));
  expect(
    (
      await client.query(
        "SELECT to_regnamespace('matching') AS matching, to_regnamespace('settlement') AS settlement, to_regclass('probabl.relayer_nonces') AS nonces",
      )
    ).rows[0],
  ).toEqual({ matching: null, settlement: null, nonces: null });
  expect((await client.query("SELECT token_hash FROM gateway.auth_sessions")).rows).toEqual([
    { token_hash: "retained" },
  ]);
  expect((await client.query("SELECT kind,state FROM gateway.operations")).rows).toEqual([
    { kind: "cancel", state: "prepared" },
  ]);
});
