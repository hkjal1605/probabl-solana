import { type Address, getAddress } from "viem";

const required = (environment: NodeJS.ProcessEnv, name: string): string => {
  const value = environment[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const address = (environment: NodeJS.ProcessEnv, name: string): Address =>
  getAddress(required(environment, name));

export interface ApiEnvironment {
  authDomain: string;
  authOrigin: string;
  chainId: number;
  conditionalTokens: Address;
  exchange: Address;
  payoutVault: Address;
  indexerUrl: string;
  atomicRouter: Address;
  marketRegistry: Address;
  positionRouter: Address;
  rpcUrl: string;
}

export const loadApiEnvironment = (environment: NodeJS.ProcessEnv): ApiEnvironment => {
  const chainId = Number(required(environment, "ROBINHOOD_CHAIN_ID"));
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error("ROBINHOOD_CHAIN_ID must be a positive safe integer");
  }
  const authOrigin = environment.API_AUTH_ORIGIN ?? "http://127.0.0.1:3000";
  const indexerUrl = environment.INDEXER_URL ?? "http://127.0.0.1:42069";
  for (const [name, value] of [
    ["API_AUTH_ORIGIN", authOrigin],
    ["INDEXER_URL", indexerUrl],
  ] as const) {
    const protocol = new URL(value).protocol;
    if (protocol !== "http:" && protocol !== "https:") throw new Error(`${name} must be HTTP(S)`);
  }
  return {
    authDomain: environment.API_AUTH_DOMAIN ?? new URL(authOrigin).host,
    authOrigin,
    chainId,
    conditionalTokens: address(environment, "CONDITIONAL_TOKENS_ADDRESS"),
    exchange: address(environment, "EXCHANGE_ADDRESS"),
    payoutVault: address(environment, "PAYOUT_VAULT_ADDRESS"),
    indexerUrl,
    atomicRouter: address(environment, "ATOMIC_ORDER_ROUTER_ADDRESS"),
    marketRegistry: address(environment, "MARKET_REGISTRY_ADDRESS"),
    positionRouter: address(environment, "POSITION_ROUTER_ADDRESS"),
    rpcUrl: required(environment, "ROBINHOOD_RPC_URL"),
  };
};
