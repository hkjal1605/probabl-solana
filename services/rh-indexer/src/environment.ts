import type { Address } from "viem";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export interface IndexerEnvironment {
  chainId: number;
  blockRetention: number;
  cacheRetention: number;
  cacheMaintenanceIntervalMs: number;
  cacheMaintenanceBatchSize: number;
  confirmationBlockCount: bigint;
  contracts: {
    conditionalTokens: Address;
    exchange: Address;
    payoutVault: Address;
    marketRegistry: Address;
    orderRecoveryRouter: Address;
    positionRouter: Address;
    protocolAuthority: Address;
    resolutionController: Address;
    settlement: Address;
  };
  deploymentBlock: number;
  endBlock?: number;
  finalityBlockCount: bigint;
  finalityMode: "rpc-tags" | "local-depth";
  confirmationMode: "safe" | "finalized" | "sequencer-depth";
  maxHeadAgeSeconds: number;
  getLogsBlockRange?: number;
  pollingInterval: number;
  rpcUrls: string[];
  websocketUrl?: string;
}

interface LoadOptions {
  allowPlaceholders?: boolean;
}

const required = (
  environment: NodeJS.ProcessEnv,
  name: string,
  allowPlaceholders: boolean,
  placeholder: string,
): string => {
  const value = environment[name];
  if (value) return value;
  if (allowPlaceholders) return placeholder;
  throw new Error(`Missing required environment variable: ${name}`);
};

const positiveSafeInteger = (name: string, value: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
};

const nonNegativeSafeInteger = (name: string, value: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return parsed;
};

const address = (
  environment: NodeJS.ProcessEnv,
  name: string,
  allowPlaceholders: boolean,
): Address => {
  const value = required(environment, name, allowPlaceholders, ZERO_ADDRESS);
  if (
    !ADDRESS_PATTERN.test(value) ||
    (!allowPlaceholders && value.toLowerCase() === ZERO_ADDRESS)
  ) {
    throw new Error(`${name} must be a non-zero 20-byte EVM address`);
  }
  return value as Address;
};

const urls = (value: string): string[] => {
  const parsed = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (parsed.length === 0) throw new Error("ROBINHOOD_RPC_URL must contain at least one RPC URL");
  for (const item of parsed) {
    const url = new URL(item);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("ROBINHOOD_RPC_URL entries must use http or https");
    }
  }
  return parsed;
};

export const loadIndexerEnvironment = (
  environment: NodeJS.ProcessEnv,
  options: LoadOptions = {},
): IndexerEnvironment => {
  const allowPlaceholders = options.allowPlaceholders ?? false;
  const finalityMode =
    environment.INDEXER_FINALITY_MODE ??
    (environment.ROBINHOOD_CHAIN_ID === "31337" || allowPlaceholders ? "local-depth" : "rpc-tags");
  const confirmationMode =
    environment.INDEXER_CONFIRMATION_MODE ??
    (finalityMode === "local-depth" ? "sequencer-depth" : "safe");
  if (finalityMode !== "rpc-tags" && finalityMode !== "local-depth")
    throw new Error("invalid INDEXER_FINALITY_MODE");
  if (!["safe", "finalized", "sequencer-depth"].includes(confirmationMode))
    throw new Error("invalid INDEXER_CONFIRMATION_MODE");
  const confirmationBlockCount = BigInt(environment.INDEXER_CONFIRMATION_BLOCKS ?? "2");
  const finalityBlockCount = BigInt(environment.INDEXER_FINALITY_BLOCKS ?? "30");
  if (confirmationBlockCount < 0n || finalityBlockCount < confirmationBlockCount) {
    throw new Error(
      "INDEXER confirmation blocks must be non-negative and no greater than finality blocks",
    );
  }
  const blockRetention = positiveSafeInteger(
    "INDEXER_BLOCK_RETENTION",
    environment.INDEXER_BLOCK_RETENTION ?? "8192",
  );
  const cacheRetention = positiveSafeInteger(
    "INDEXER_CACHE_RETENTION",
    environment.INDEXER_CACHE_RETENTION ?? "8192",
  );
  if (blockRetention > 2_147_483_647 || BigInt(blockRetention) <= confirmationBlockCount)
    throw new Error("INDEXER_BLOCK_RETENTION must fit int32 and exceed confirmation depth");
  const cacheMaintenanceBatchSize = positiveSafeInteger(
    "INDEXER_CACHE_MAINTENANCE_BATCH_SIZE",
    environment.INDEXER_CACHE_MAINTENANCE_BATCH_SIZE ?? "2000",
  );
  if (cacheMaintenanceBatchSize > 10_000)
    throw new Error("INDEXER_CACHE_MAINTENANCE_BATCH_SIZE must not exceed 10000");

  const getLogsBlockRange = environment.INDEXER_GET_LOGS_BLOCK_RANGE
    ? positiveSafeInteger("INDEXER_GET_LOGS_BLOCK_RANGE", environment.INDEXER_GET_LOGS_BLOCK_RANGE)
    : undefined;
  const endBlock = environment.INDEXER_END_BLOCK
    ? nonNegativeSafeInteger("INDEXER_END_BLOCK", environment.INDEXER_END_BLOCK)
    : undefined;
  const deploymentBlock = nonNegativeSafeInteger(
    "DEPLOYMENT_BLOCK",
    required(environment, "DEPLOYMENT_BLOCK", allowPlaceholders, "0"),
  );
  if (endBlock !== undefined && endBlock < deploymentBlock) {
    throw new Error("INDEXER_END_BLOCK must be greater than or equal to DEPLOYMENT_BLOCK");
  }
  const websocketUrl = environment.ROBINHOOD_WS_URL;
  if (websocketUrl && !/^wss?:\/\//.test(websocketUrl)) {
    throw new Error("ROBINHOOD_WS_URL must use ws or wss");
  }

  return {
    blockRetention,
    cacheRetention,
    cacheMaintenanceIntervalMs: positiveSafeInteger(
      "INDEXER_CACHE_MAINTENANCE_INTERVAL_MS",
      environment.INDEXER_CACHE_MAINTENANCE_INTERVAL_MS ?? "15000",
    ),
    cacheMaintenanceBatchSize,
    chainId: positiveSafeInteger(
      "ROBINHOOD_CHAIN_ID",
      required(environment, "ROBINHOOD_CHAIN_ID", allowPlaceholders, "31337"),
    ),
    confirmationBlockCount,
    contracts: {
      conditionalTokens: address(environment, "CONDITIONAL_TOKENS_ADDRESS", allowPlaceholders),
      exchange: address(environment, "EXCHANGE_ADDRESS", allowPlaceholders),
      payoutVault: address(environment, "PAYOUT_VAULT_ADDRESS", allowPlaceholders),
      marketRegistry: address(environment, "MARKET_REGISTRY_ADDRESS", allowPlaceholders),
      orderRecoveryRouter: address(environment, "ORDER_RECOVERY_ROUTER_ADDRESS", allowPlaceholders),
      positionRouter: address(environment, "POSITION_ROUTER_ADDRESS", allowPlaceholders),
      protocolAuthority: address(environment, "PROTOCOL_AUTHORITY_ADDRESS", allowPlaceholders),
      resolutionController: address(
        environment,
        "RESOLUTION_CONTROLLER_ADDRESS",
        allowPlaceholders,
      ),
      settlement: address(environment, "SETTLEMENT_ADDRESS", allowPlaceholders),
    },
    deploymentBlock,
    ...(endBlock === undefined ? {} : { endBlock }),
    finalityBlockCount,
    finalityMode,
    confirmationMode: confirmationMode as IndexerEnvironment["confirmationMode"],
    maxHeadAgeSeconds: positiveSafeInteger(
      "INDEXER_MAX_HEAD_AGE_SECONDS",
      environment.INDEXER_MAX_HEAD_AGE_SECONDS ?? "30",
    ),
    ...(getLogsBlockRange === undefined ? {} : { getLogsBlockRange }),
    pollingInterval: positiveSafeInteger(
      "INDEXER_POLLING_INTERVAL_MS",
      environment.INDEXER_POLLING_INTERVAL_MS ?? "1000",
    ),
    rpcUrls: urls(
      required(environment, "ROBINHOOD_RPC_URL", allowPlaceholders, "http://127.0.0.1:8545"),
    ),
    ...(websocketUrl ? { websocketUrl } : {}),
  };
};
