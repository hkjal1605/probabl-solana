import { resolve } from "node:path";
import {
  type Abi,
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  getAddress,
  type Hex,
  http,
  keccak256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  assertReviewedBuild,
  type BuildMetadata,
  CTF_CREATION_HASH,
  CTF_RUNTIME_HASH,
} from "./security.ts";

export interface FoundryArtifact {
  abi: Abi;
  bytecode: { object: Hex };
  deployedBytecode: { object: Hex };
  metadata: BuildMetadata;
}

export const requiredEnvironment = (name: string): string => {
  const value = Bun.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

export const environmentAddress = (name: string): Address => getAddress(requiredEnvironment(name));

export const environmentBigInt = (name: string): bigint => {
  const value = BigInt(requiredEnvironment(name));
  if (value < 0n) throw new Error(`${name} must not be negative`);
  return value;
};

export const environmentHex32 = (name: string): Hex => {
  const value = requiredEnvironment(name) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} must be bytes32`);
  return value;
};

export const loadArtifact = async (
  contractName: string,
  sourceName = contractName,
): Promise<FoundryArtifact> => {
  const path = resolve(import.meta.dir, `../out/${sourceName}.sol/${contractName}.json`);
  const artifact = (await Bun.file(path).json()) as Partial<FoundryArtifact>;
  if (!artifact.abi || !artifact.bytecode?.object || !artifact.deployedBytecode?.object) {
    throw new Error(`Run forge build before loading ${contractName}`);
  }
  if (!artifact.metadata) throw new Error(`Missing compiler metadata for ${contractName}`);
  await assertReviewedBuild(artifact.metadata);
  return artifact as FoundryArtifact;
};

export const loadConditionalTokensArtifact = async (): Promise<{
  abi: Abi;
  bytecode: Hex;
  deployedBytecode: Hex;
}> => {
  const path = resolve(
    import.meta.dir,
    "../node_modules/@gnosis.pm/conditional-tokens-contracts/build/contracts/ConditionalTokens.json",
  );
  const artifact = (await Bun.file(path).json()) as {
    abi?: Abi;
    bytecode?: Hex;
    deployedBytecode?: Hex;
  };
  if (!artifact.abi || !artifact.bytecode || !artifact.deployedBytecode) {
    throw new Error("Invalid pinned CTF artifact");
  }
  if (
    keccak256(artifact.bytecode) !== CTF_CREATION_HASH ||
    keccak256(artifact.deployedBytecode) !== CTF_RUNTIME_HASH
  ) {
    throw new Error("Pinned Conditional Tokens artifact has changed; a new audit is required");
  }
  return {
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    deployedBytecode: artifact.deployedBytecode,
  };
};

export const createPublicChainClient = async () => {
  const chainId = Number(environmentBigInt("EXPECTED_CHAIN_ID"));
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error("EXPECTED_CHAIN_ID must be a positive safe integer");
  }
  const rpcUrl = requiredEnvironment("ROBINHOOD_RPC_URL");
  const chain: Chain = {
    id: chainId,
    name: `Robinhood Chain ${chainId}`,
    nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const actualChainId = await publicClient.getChainId();
  if (actualChainId !== chainId) {
    throw new Error(`Wrong RPC network: expected ${chainId}, received ${actualChainId}`);
  }
  return { chain, chainId, publicClient };
};

export const createChainClients = async (privateKeyName: string) => {
  const { chain, chainId, publicClient } = await createPublicChainClient();
  const privateKey = requiredEnvironment(privateKeyName) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error(`${privateKeyName} must be a 32-byte private key`);
  }
  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(chain.rpcUrls.default.http[0]),
  });
  return { account, chain, chainId, publicClient, walletClient };
};

export const assertContract = async (
  publicClient: ReturnType<typeof createPublicClient>,
  address: Address,
  label: string,
): Promise<void> => {
  const code = await publicClient.getBytecode({ address });
  if (!code || code === "0x") throw new Error(`${label} has no code at ${address}`);
};

export const writeOutput = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};
