import { describe, expect, test } from "bun:test";
import { Buffer } from "buffer";
import {
  TransactionInstruction,
  TransactionMessage,
  Keypair,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import { SolanaClient, coder, BN } from "@conditional-stocks/solana-client";
import { type Pool } from "pg";
import { decodeHistory, replayHistory } from "../src/history.ts";
import idl from "../../../packages/solana-client/src/idl.json";

const config = Keypair.generate().publicKey,
  actor = Keypair.generate().publicKey,
  market = Keypair.generate().publicKey;
const client = new SolanaClient({
  rpcUrl: "http://127.0.0.1:8899",
  config: config.toBase58(),
  genesisHash: Keypair.generate().publicKey.toBase58(),
});
function transaction(
  logs: string[] | null,
  initialize = false,
  failed = false,
  program = client.program,
): VersionedTransactionResponse {
  const ix = new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: actor, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
    ],
    data: coder.instruction.encode(
      initialize ? "initialize" : "pause",
      initialize
        ? { roles: { market_admin: actor, guardian: actor, resolution_admin: actor } }
        : { paused: true, reason: Array(32).fill(1) },
    ),
  });
  return {
    slot: 100,
    blockTime: 1000,
    version: 0,
    transaction: {
      signatures: [],
      message: new TransactionMessage({
        payerKey: actor,
        recentBlockhash: Keypair.generate().publicKey.toBase58(),
        instructions: [ix],
      }).compileToV0Message(),
    },
    meta: {
      err: failed ? { InstructionError: [0, "InvalidArgument"] } : null,
      fee: 5000,
      preBalances: [],
      postBalances: [],
      logMessages: logs,
      loadedAddresses: { readonly: [], writable: [] },
    },
  };
}
const invocation = (data?: string) => [
  `Program ${client.program} invoke [1]`,
  ...(data ? [`Program data: ${data}`] : []),
  `Program ${client.program} success`,
];
function eventData() {
  const event = coder.types.encode("Change", {
    market,
    account: actor,
    kind: 4,
    amount: new BN("18446744073709551615"),
    asset: 0,
  });
  const discriminator = Buffer.from(idl.events.find((e) => e.name === "Change")!.discriminator);
  return Buffer.concat([discriminator, event]).toString("base64");
}
function database(cursor?: { signature: string; slot: string; snapshot_slot: string }) {
  const calls: { sql: string; args?: unknown[] }[] = [];
  let released = false;
  const connection = {
    query: async (sql: string, args?: unknown[]) => {
      calls.push({ sql, ...(args ? { args } : {}) });
      return {
        rows: sql.startsWith("SELECT * FROM solana_history_cursors")
          ? cursor
            ? [cursor]
            : []
          : [],
      };
    },
    release: () => {
      released = true;
    },
  };
  return {
    db: { connect: async () => connection } as unknown as Pool,
    calls,
    released: () => released,
  };
}
const row = (signature: string, slot: number, err: unknown = null) => ({
  signature,
  slot,
  err,
  memo: null,
  blockTime: 1000,
  confirmationStatus: "finalized" as const,
});
function rpc(
  pages: ReturnType<typeof row>[][],
  responses: Record<string, VersionedTransactionResponse | null> = {},
  first = 0,
) {
  let page = 0;
  const fetched: string[] = [];
  const connection = {
    getFirstAvailableBlock: async () => first,
    getSignaturesForAddress: async () => pages[page++] ?? [],
    getTransaction: async (signature: string) => {
      fetched.push(signature);
      return responses[signature] ?? null;
    },
  };
  return {
    client: {
      config: client.config,
      program: client.program,
      connection,
    } as unknown as SolanaClient,
    fetched,
  };
}

describe("finalized history integrity", () => {
  test("native events retain exact u64 values and invocation attribution", () => {
    const data = eventData();
    const decoded = decodeHistory(client, transaction(invocation(data), true));
    expect(decoded.initialized).toBe(true);
    expect(decoded.events).toHaveLength(1);
    expect(decoded.events[0]?.data.amount).toBe("18446744073709551615");
    expect(decoded.events[0]?.market).toBe(market.toBase58());
    const foreign = Keypair.generate().publicKey;
    expect(
      decodeHistory(
        client,
        transaction(
          [`Program ${foreign} invoke [1]`, `Program data: ${data}`, `Program ${foreign} success`],
          false,
          false,
          foreign,
        ),
      ).events,
    ).toEqual([]);
    expect(
      decodeHistory(
        client,
        transaction([
          `Program ${client.program} invoke [1]`,
          `Program ${foreign} invoke [2]`,
          `Program data: ${data}`,
          `Program ${foreign} success`,
          `Program ${client.program} success`,
        ]),
      ).events,
    ).toEqual([]);
  });
  test("failed transactions cannot initialize history or contribute emitted events", () => {
    expect(decodeHistory(client, transaction(null, true, true))).toEqual({
      initialized: false,
      events: [],
    });
  });
  test("missing, truncated, unknown and malformed event logs fail closed", () => {
    for (const logs of [
      null,
      [],
      ["Log truncated"],
      [`Program ${client.program} invoke [1]`],
      invocation("AAAA"),
      invocation(Buffer.alloc(100).toString("base64")),
    ])
      expect(() => decodeHistory(client, transaction(logs))).toThrow();
  });
  test("caught CPI failures and failed ancestors discard their events even in successful transactions", () => {
    const outer = Keypair.generate().publicKey,
      middle = Keypair.generate().publicKey,
      data = eventData();
    for (const child of [
      [
        `Program ${client.program} invoke [2]`,
        `Program data: ${data}`,
        `Program ${client.program} failed: custom program error: 1`,
      ],
      [
        `Program ${middle} invoke [2]`,
        `Program ${client.program} invoke [3]`,
        `Program data: ${data}`,
        `Program ${client.program} success`,
        `Program ${middle} failed: custom program error: 1`,
      ],
    ])
      expect(
        decodeHistory(
          client,
          transaction(
            [`Program ${outer} invoke [1]`, ...child, `Program ${outer} success`],
            false,
            false,
            outer,
          ),
        ).events,
      ).toEqual([]);
    const logs = [
      `Program ${outer} invoke [1]`,
      `Program ${client.program} invoke [2]`,
      `Program data: ${data}`,
      `Program ${client.program} success`,
      `Program ${outer} success`,
    ];
    expect(decodeHistory(client, transaction(logs, false, false, outer)).events).toHaveLength(1);
  });
  test("untrusted text mentioning truncation cannot poison deployment history", () => {
    expect(
      decodeHistory(
        client,
        transaction([
          `Program ${client.program} invoke [1]`,
          "Program log: Log truncated",
          `Program ${client.program} success`,
        ]),
      ).events,
    ).toEqual([]);
  });
  test("quiet continuously scanned deployments do not require an aged-out signature", async () => {
    const db = database({ signature: "old-pruned-signature", slot: "2", snapshot_slot: "99" }),
      source = rpc([[]], {}, 100);
    await replayHistory(db.db, source.client, "domain", 105);
    expect(
      db.calls.find((c) => c.sql.startsWith("INSERT INTO solana_history_cursors"))?.args,
    ).toEqual(["domain", "old-pruned-signature", "2", 105]);
    expect(source.fetched).toEqual([]);
    expect(db.released()).toBe(true);
  });
  test("a genuine retention gap rolls back without advancing the checkpoint", async () => {
    const db = database({ signature: "old", slot: "2", snapshot_slot: "99" }),
      source = rpc([[]], {}, 101);
    await expect(replayHistory(db.db, source.client, "domain", 105)).rejects.toThrow(
      "archival recovery",
    );
    expect(db.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(db.calls.some((c) => c.sql.startsWith("INSERT"))).toBe(false);
    expect(db.released()).toBe(true);
  });
  test("the boundary slot is replayed and newer-than-snapshot transactions are deferred", async () => {
    const db = database({ signature: "a", slot: "100", snapshot_slot: "100" });
    const tx = transaction(invocation());
    const source = rpc([[row("future", 102), row("b", 100), row("a", 100), row("older", 99)]], {
      a: tx,
      b: tx,
    });
    await replayHistory(db.db, source.client, "domain", 101);
    expect(source.fetched).toEqual(["a", "b"]);
    expect(
      db.calls.find((c) => c.sql.startsWith("INSERT INTO solana_history_cursors"))?.args,
    ).toEqual(["domain", "b", 100, 101]);
  });
  test("first backfill must include the exact deployment initialization", async () => {
    const db = database(),
      source = rpc([[row("initialization", 100)]], {
        initialization: transaction(invocation(), true),
      });
    await replayHistory(db.db, source.client, "domain", 101);
    expect(db.calls.at(-1)?.sql).toBe("COMMIT");
    const absent = database(),
      empty = rpc([[row("pause", 100)]], { pause: transaction(invocation()) });
    await expect(replayHistory(absent.db, empty.client, "domain", 101)).rejects.toThrow(
      "initialization is missing",
    );
    expect(absent.calls.at(-1)?.sql).toBe("ROLLBACK");
  });
  test("missing transaction or timestamp prevents publishing a partial replay", async () => {
    for (const response of [
      null,
      { ...transaction(invocation(eventData()), true), blockTime: null },
    ]) {
      const db = database(),
        source = rpc([[row("missing", 100)]], { missing: response });
      await expect(replayHistory(db.db, source.client, "domain", 101)).rejects.toThrow();
      expect(db.calls.at(-1)?.sql).toBe("ROLLBACK");
      expect(db.released()).toBe(true);
    }
  });
  test("a stale concurrent snapshot never moves the durable cursor backwards", async () => {
    const db = database({ signature: "a", slot: "100", snapshot_slot: "105" }),
      source = rpc([[]]);
    await replayHistory(db.db, source.client, "domain", 101);
    expect(db.calls.at(-1)?.sql).toBe("COMMIT");
    expect(db.calls.some((c) => c.sql.startsWith("INSERT"))).toBe(false);
  });
});
