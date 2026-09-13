/** Bounded, read-only EC2 catch-up observation. Never print RPC credentials or metric labels. */
import { Client } from "pg";

const schema = process.env.DATABASE_SCHEMA;
if (!schema || !/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error("Invalid indexer schema");
const duration = Number(process.argv[2] ?? "360");
if (!Number.isSafeInteger(duration) || duration < 20 || duration > 1800)
  throw new Error("Monitor duration must be 20–1800 seconds");
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10000,
  options: "-c default_transaction_read_only=on -c statement_timeout=10000",
});
const total = (body: string, name: string) =>
  body
    .split("\n")
    .filter((line) => line.startsWith(`${name}{`) || line.startsWith(`${name} `))
    .reduce((sum, line) => sum + Number(line.trim().split(/\s+/).at(-1) ?? 0), 0);
async function json(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  return {
    status: response.status,
    data: (await response.json()) as {
      latestReport?: { status?: string; issues?: unknown[] } | null;
    },
  };
}
let previous: { at: number; requests: number; errors: number } | undefined;
try {
  await client.connect();
  const until = Date.now() + duration * 1000;
  do {
    const at = Date.now();
    let head: number | null = null;
    let rpcHttp = 0;
    try {
      const response = await fetch(process.env.ROBINHOOD_RPC_URL ?? "", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
        signal: AbortSignal.timeout(10000),
      });
      rpcHttp = response.status;
      const rpc = (await response.json().catch(() => ({}))) as { result?: string };
      if (rpc.result) head = Number(BigInt(rpc.result));
    } catch {
      /* A failed provider probe is an observation, not a reason to stop monitoring. */
    }
    const state = (await client.query(`SELECT * FROM "${schema}".indexer_state`)).rows[0];
    const [indexer, ready, reconciliation, metrics] = await Promise.all([
      json("http://127.0.0.1:42069/indexer/health"),
      json("http://127.0.0.1:3000/ready"),
      json("http://127.0.0.1:42070/health"),
      fetch("http://127.0.0.1:42069/metrics", { signal: AbortSignal.timeout(10000) }).then((r) =>
        r.text(),
      ),
    ]);
    const requests = total(metrics, "ponder_rpc_request_duration_count");
    const errors = total(metrics, "ponder_rpc_request_error_total");
    const indexedBlock = Number(state?.indexed_block ?? state?.indexedBlock ?? 0);
    const timestamp = Number(state?.indexed_block_timestamp ?? state?.indexedBlockTimestamp ?? 0);
    console.info(
      JSON.stringify({
        at: new Date(at).toISOString(),
        chainHead: head,
        rpcHttp,
        indexedBlock,
        lagBlocks: head === null ? null : head - indexedBlock,
        headAgeSeconds: timestamp ? Math.max(0, Math.floor(at / 1000) - timestamp) : null,
        indexerHttp: indexer.status,
        readyHttp: ready.status,
        reconciliationHttp: reconciliation.status,
        reconciliationStatus: reconciliation.data.latestReport?.status ?? null,
        reconciliationIssues: reconciliation.data.latestReport?.issues?.length ?? null,
        rpcRequests: requests,
        rpcErrors: errors,
        ...(previous
          ? {
              rpcRps: Number(
                (((requests - previous.requests) * 1000) / (at - previous.at)).toFixed(2),
              ),
              newRpcErrors: errors - previous.errors,
            }
          : {}),
      }),
    );
    previous = { at, requests, errors };
    if (Date.now() >= until) break;
    await Bun.sleep(Math.min(20000, until - Date.now()));
  } while (Date.now() <= until);
} catch {
  console.error("Indexer monitor failed; RPC/database credentials withheld");
  process.exitCode = 1;
} finally {
  await client.end();
}
