// Reconciliation runs continuously inside the indexer. This command probes it
// without launching another writer or binding the same service port.
const response = await fetch(
  new URL("/reconciliation", process.env.INDEXER_URL ?? "http://127.0.0.1:42069"),
  {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  },
);
const report = (await response.json()) as { healthy?: boolean };
console.info(JSON.stringify(report, null, 2));
if (!response.ok || report.healthy !== true) process.exit(1);
