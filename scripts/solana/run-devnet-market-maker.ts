import { resolve } from "node:path";
import { Connection } from "@solana/web3.js";
import { assertDevnet } from "./devnet-policy.ts";

const ROOT = resolve(import.meta.dir, "../..");
const PROGRAM = "8S7LwM6yRszZaAoEQqgE1AYcZJLpyVVC5MRr7vqCxLtg";
const CONFIG = "6buYkVtSJjaoozCDsPFYrPhp5g1q1oLg2eLp7FpsZ1tF";
const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

if (!process.argv.includes("--execute"))
  throw new Error("Devnet market-maker execution requires --execute");
const rpc = process.env.DEVNET_BROWSER_RPC_URL ?? process.env.DEVNET_RPC_URL;
if (!rpc) throw new Error("DEVNET_BROWSER_RPC_URL or DEVNET_RPC_URL is required");
await assertDevnet(new Connection(rpc, "confirmed"));
process.env.MM_MODE = "live";
process.env.MM_RPC_URL = rpc;
process.env.MM_GENESIS_HASH = GENESIS;
process.env.MM_SOLANA_CONFIG = CONFIG;
process.env.MM_PROGRAM_ID = PROGRAM;
process.env.MM_API_ORIGIN = "https://api-solana.probabl.trade";
process.env.MM_CONFIG_PATH = resolve(ROOT, ".local/devnet/market-maker-all.json");
// Multi-issuer policies (baseMints per market) never reuse single-base v2 state.
process.env.MM_STATE_PATH = resolve(ROOT, ".local/devnet/market-maker-v3-state.json");
await import("../../services/market-maker/src/main.ts");
