// Explicit operator action, never part of order review or wallet input changes.
import { readFileSync } from "node:fs";
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  SolanaClient,
  key,
  claimAddress,
  vaultAddress,
  traderAddress,
  walletAddress,
  poolAddress,
  poolVaultAddress,
  assetCreditAddress,
} from "@conditional-stocks/solana-client";

if (!process.argv.includes("--execute"))
  throw new Error("Creating/funding/freezing a lookup table requires --execute");
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const client = new SolanaClient({
  rpcUrl: required("SOLANA_RPC_URL"),
  config: required("SOLANA_CONFIG"),
  genesisHash: required("SOLANA_GENESIS_HASH"),
});
await client.assertNetwork();
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(required("SOLANA_PAYER_KEYPAIR"), "utf8"))),
);
const markets = [
  ...new Set(
    (process.env.LOOKUP_TABLE_MARKETS ?? required("LOOKUP_TABLE_MARKET"))
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  ),
].map(key);
if (!markets.length || markets.length > 64) throw new Error("Invalid market list");
const marketAccounts = await Promise.all(markets.map((market) => client.market(market)));
const owners = (process.env.LOOKUP_TABLE_OWNERS ?? "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean)
  .map(key);
const addresses = [
  client.config,
  client.program,
  SystemProgram.programId,
  TOKEN_PROGRAM_ID,
  ComputeBudgetProgram.programId,
];
for (const [index, market] of markets.entries()) {
  addresses.push(market);
  for (const mint of marketAccounts[index]!.mints.slice(0, 2)) {
    const pool = poolAddress(client.config, mint, client.program);
    addresses.push(mint, pool, poolVaultAddress(pool, client.program));
    for (const owner of owners) addresses.push(assetCreditAddress(pool, owner, client.program));
  }
  for (let i = 2; i < 6; i++) {
    addresses.push(vaultAddress(market, i, client.program));
    if (i >= 2) addresses.push(claimAddress(market, i, client.program));
  }
  for (const owner of owners) addresses.push(walletAddress(market, owner, client.program));
}
for (const owner of owners) addresses.push(traderAddress(client.config, owner, client.program));
const unique = [...new Map(addresses.map((a) => [a.toBase58(), a])).values()];
if (unique.length > 256) throw new Error("Too many lookup addresses");
// ALTs are not protocol envelopes; the table program is intentionally not in
// the trading SDK's instruction allowlist.
const { TransactionMessage, VersionedTransaction } = await import("@solana/web3.js");
async function send(instruction: import("@solana/web3.js").TransactionInstruction) {
  const latest = await client.connection.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: latest.blockhash,
      instructions: [instruction],
    }).compileToV0Message(),
  );
  tx.sign([payer]);
  const signature = await client.connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  const result = await client.connection.confirmTransaction({ ...latest, signature }, "confirmed");
  if (result.value.err) throw new Error("Lookup table operation failed");
}
const [create, table] = AddressLookupTableProgram.createLookupTable({
  authority: payer.publicKey,
  payer: payer.publicKey,
  recentSlot: await client.connection.getSlot("finalized"),
});
await send(create);
// Print immediately so an interrupted operator can locate/close a still-mutable table.
console.log(JSON.stringify({ event: "lookup-table-created", address: table.toBase58() }));
for (let i = 0; i < unique.length; i += 20) {
  await send(
    AddressLookupTableProgram.extendLookupTable({
      lookupTable: table,
      authority: payer.publicKey,
      payer: payer.publicKey,
      addresses: unique.slice(i, i + 20),
    }),
  );
}
// Freezing is intentional and irreversible: immutable entries can be safely
// cached without per-trade RPC, but this table's rent cannot later be reclaimed.
await send(
  AddressLookupTableProgram.freezeLookupTable({ lookupTable: table, authority: payer.publicKey }),
);
console.log(
  JSON.stringify({
    event: "lookup-table-frozen",
    address: table.toBase58(),
    entries: unique.length,
    configure: ["SOLANA_ADDRESS_LOOKUP_TABLES", "NEXT_PUBLIC_SOLANA_ADDRESS_LOOKUP_TABLES"],
  }),
);
