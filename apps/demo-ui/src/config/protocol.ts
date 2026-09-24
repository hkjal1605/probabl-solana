import { CLUSTER_NAME, CONFIG_ACCOUNT, GENESIS_HASH, PROGRAM_ID } from "@/protocol/config";

export const protocolConfig = {
  chainId: 1, // UI compatibility key; genesisHash is the actual network identity.
  chainName: CLUSTER_NAME,
  programId: PROGRAM_ID,
  config: CONFIG_ACCOUNT,
  genesisHash: GENESIS_HASH,
  addressLookupTables: [] as string[],
  rpcUrl: "",
  explorerUrl: "" as string,
} as const;
