import {
  conditionalExchangeAbi,
  conditionalSettlementAbi,
  conditionalTokensAbi,
  manualResolutionControllerAbi,
  marketRegistryAbi,
  orderRecoveryRouterAbi,
  payoutVaultAbi,
  positionRouterAbi,
  protocolAuthorityAbi,
} from "@conditional-stocks/contract-bindings";
import { databaseUrl } from "@conditional-stocks/db/connection";
import { createConfig } from "ponder";
import { pacedRpc } from "./rpc-pacing.ts";
import { loadIndexerEnvironment } from "./src/environment.ts";

if (
  process.env.PONDER_ALLOW_PLACEHOLDERS !== "true" &&
  process.env.CONDITIONAL_INDEXER_RUNTIME !== "bounded-cache-v1"
)
  throw new Error(
    "Use scripts/ponder.ts (or package start/dev scripts) for isolated, bounded cache management",
  );

export const indexerEnvironment = loadIndexerEnvironment(process.env, {
  allowPlaceholders: process.env.PONDER_ALLOW_PLACEHOLDERS === "true",
});

const { contracts, deploymentBlock } = indexerEnvironment;
// Operational transport settings stay outside src/: Ponder hashes every source
// file there as indexing logic, even when it does not contain event handlers.
const rpcMaxRps = process.env.INDEXER_RPC_MAX_RPS
  ? Number(process.env.INDEXER_RPC_MAX_RPS)
  : undefined;
const endBlock = indexerEnvironment.endBlock;
const sourceRange = {
  startBlock: deploymentBlock,
  ...(endBlock === undefined ? {} : { endBlock }),
};

if (process.env.PONDER_DATABASE_DIRECTORY !== undefined)
  throw new Error("PONDER_DATABASE_DIRECTORY is obsolete; use the shared DATABASE_URL");
const connectionString = databaseUrl(
  process.env.DATABASE_URL ??
    (process.env.PONDER_ALLOW_PLACEHOLDERS === "true"
      ? "postgresql://placeholder@127.0.0.1:5432/placeholder"
      : undefined),
);
const databasePoolSize = Number(process.env.PONDER_DATABASE_POOL_SIZE ?? "20");
if (!Number.isSafeInteger(databasePoolSize) || databasePoolSize < 5 || databasePoolSize > 100)
  throw new Error("PONDER_DATABASE_POOL_SIZE must be between 5 and 100");

export default createConfig({
  database: {
    kind: "postgres",
    connectionString,
    poolConfig: { max: databasePoolSize },
  },
  chains: {
    robinhood: {
      id: indexerEnvironment.chainId,
      rpc:
        rpcMaxRps === undefined
          ? indexerEnvironment.rpcUrls
          : pacedRpc(indexerEnvironment.rpcUrls, rpcMaxRps),
      ...(indexerEnvironment.websocketUrl ? { ws: indexerEnvironment.websocketUrl } : {}),
      pollingInterval: indexerEnvironment.pollingInterval,
      disableCache: process.env.PONDER_DISABLE_CACHE === "true",
      ...(indexerEnvironment.getLogsBlockRange === undefined
        ? {}
        : { ethGetLogsBlockRange: indexerEnvironment.getLogsBlockRange }),
    },
  },
  contracts: {
    PayoutVault: {
      abi: payoutVaultAbi,
      address: contracts.payoutVault,
      chain: "robinhood",
      ...sourceRange,
    },
    ConditionalTokens: {
      abi: conditionalTokensAbi,
      address: contracts.conditionalTokens,
      chain: "robinhood",
      ...sourceRange,
    },
    ConditionalExchange: {
      abi: conditionalExchangeAbi,
      address: contracts.exchange,
      chain: "robinhood",
      ...sourceRange,
    },
    ConditionalSettlement: {
      abi: conditionalSettlementAbi,
      address: contracts.settlement,
      chain: "robinhood",
      ...sourceRange,
    },
    ManualResolutionController: {
      abi: manualResolutionControllerAbi,
      address: contracts.resolutionController,
      chain: "robinhood",
      ...sourceRange,
    },
    MarketRegistry: {
      abi: marketRegistryAbi,
      address: contracts.marketRegistry,
      chain: "robinhood",
      ...sourceRange,
    },
    OrderRecoveryRouter: {
      abi: orderRecoveryRouterAbi,
      address: contracts.orderRecoveryRouter,
      chain: "robinhood",
      ...sourceRange,
    },
    PositionRouter: {
      abi: positionRouterAbi,
      address: contracts.positionRouter,
      chain: "robinhood",
      ...sourceRange,
    },
    ProtocolAuthority: {
      abi: protocolAuthorityAbi,
      address: contracts.protocolAuthority,
      chain: "robinhood",
      ...sourceRange,
    },
  },
  blocks: {
    ProtocolBlock: {
      chain: "robinhood",
      interval: 1,
      ...sourceRange,
    },
  },
});
