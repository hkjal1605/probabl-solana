import { PROGRAM_ID } from "@conditional-stocks/solana-client";
const programId=process.env.NEXT_PUBLIC_SOLANA_PROGRAM_ID??PROGRAM_ID.toBase58();
const marketAdmin=process.env.NEXT_PUBLIC_SOLANA_MARKET_ADMIN??"";
export const adminConfig={
  chainId:1 as const,chainName:process.env.NEXT_PUBLIC_SOLANA_CLUSTER_NAME??"Solana Localnet",
  programId,config:process.env.NEXT_PUBLIC_SOLANA_CONFIG??"",genesisHash:process.env.NEXT_PUBLIC_SOLANA_GENESIS_HASH??"",
  rpcUrl:process.env.NEXT_PUBLIC_SOLANA_RPC_URL??"http://127.0.0.1:8899",
  marketAdmin,resolutionAdmin:process.env.NEXT_PUBLIC_SOLANA_RESOLUTION_ADMIN??marketAdmin,
  polygonConditionalTokens:process.env.NEXT_PUBLIC_POLYGON_CONDITIONAL_TOKENS_ADDRESS??"",
}as const;
