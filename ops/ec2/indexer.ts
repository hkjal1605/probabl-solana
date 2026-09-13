// Keep the contract preflight on every restart without hiding Ponder in a child
// process: PM2 must monitor the actual indexer's memory and deliver its signals.
await import("../../services/rh-indexer/scripts/preflight.ts");
await import("../../services/rh-indexer/scripts/ponder.ts");

export {};
