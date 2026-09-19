import { PROGRAM_ID } from "@conditional-stocks/solana-client";
const programId=process.env.NEXT_PUBLIC_SOLANA_PROGRAM_ID??PROGRAM_ID.toBase58();
export const protocolConfig={
  chainId:1, // UI compatibility key; genesisHash is the actual network identity.
  chainName:process.env.NEXT_PUBLIC_SOLANA_CLUSTER_NAME??"Solana Localnet",
  programId,config:process.env.NEXT_PUBLIC_SOLANA_CONFIG??"",
  genesisHash:process.env.NEXT_PUBLIC_SOLANA_GENESIS_HASH??"",
  addressLookupTables:(process.env.NEXT_PUBLIC_SOLANA_ADDRESS_LOOKUP_TABLES??"").split(",").map((v)=>v.trim()).filter(Boolean),
  rpcUrl:process.env.NEXT_PUBLIC_SOLANA_RPC_URL??"http://127.0.0.1:8899",
  explorerUrl:process.env.NEXT_PUBLIC_SOLANA_EXPLORER_URL??"",
}as const;
