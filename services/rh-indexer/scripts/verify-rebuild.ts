import type { ReconciliationSnapshot } from "@conditional-stocks/db/reconciliation/types";
import { hashProjection } from "../src/reconciliation/engine.ts";

const primaryUrl = process.env.PRIMARY_INDEXER_URL ?? "http://127.0.0.1:42069";
const rebuiltUrl = process.env.REBUILT_INDEXER_URL ?? "http://127.0.0.1:42071";

const load = async (baseUrl: string): Promise<ReconciliationSnapshot> => {
  const response = await fetch(`${baseUrl}/internal/reconciliation-snapshot?deep=true`);
  if (!response.ok) throw new Error(`${baseUrl} returned HTTP ${response.status}`);
  return response.json() as Promise<ReconciliationSnapshot>;
};

const [primary, rebuilt] = await Promise.all([load(primaryUrl), load(rebuiltUrl)]);
if (
  primary.state.indexedBlock !== rebuilt.state.indexedBlock ||
  primary.state.indexedBlockHash.toLowerCase() !== rebuilt.state.indexedBlockHash.toLowerCase()
) {
  throw new Error(
    `indexers are not at the same head: ${primary.state.indexedBlock}/${primary.state.indexedBlockHash} versus ${rebuilt.state.indexedBlock}/${rebuilt.state.indexedBlockHash}`,
  );
}
const primaryHash = hashProjection(primary);
const rebuiltHash = hashProjection(rebuilt);
if (primaryHash !== rebuiltHash) {
  throw new Error(`clean replay mismatch: primary=${primaryHash} rebuilt=${rebuiltHash}`);
}
process.stdout.write(
  `${JSON.stringify(
    {
      indexedBlock: primary.state.indexedBlock,
      indexedBlockHash: primary.state.indexedBlockHash,
      projectionHash: primaryHash,
      projectionVersion: 3,
    },
    null,
    2,
  )}\n`,
);
