// Explicit operator action, never part of order review or wallet input changes.
import { readFileSync } from "node:fs";
import {
  assetCreditAddress,
  claimAddress,
  claimAsset,
  delegationAddress,
  key,
  poolAddress,
  poolVaultAddress,
  SolanaClient,
  traderAddress,
  underlyingAsset,
  vaultAddress,
  walletAddress,
} from "@conditional-stocks/solana-client";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
} from "@solana/web3.js";
import { assertDevnet, parseDeployer } from "./devnet-policy.ts";

if (!process.argv.includes("--execute"))
  throw new Error("Creating/funding/freezing a lookup table requires --execute");
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const keypairFile = process.env.SOLANA_PAYER_KEYPAIR?.trim();
const usingDevnetSecret = !keypairFile;
const client = new SolanaClient({
  rpcUrl:
    (usingDevnetSecret ? process.env.DEVNET_BROWSER_RPC_URL : undefined) ??
    required("SOLANA_RPC_URL"),
  config: required("SOLANA_CONFIG"),
  genesisHash: required("SOLANA_GENESIS_HASH"),
});
await client.assertNetwork();
if (usingDevnetSecret) await assertDevnet(client.connection);
const payer = keypairFile
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairFile, "utf8"))))
  : parseDeployer(process.env.DEVNET_DEPLOYER_PRIVATE_KEY);
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
const delegates = (process.env.LOOKUP_TABLE_DELEGATES ?? "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean)
  .map(key);
const addresses = [
  client.config,
  client.program,
  SystemProgram.programId,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ComputeBudgetProgram.programId,
];
for (const [index, market] of markets.entries()) {
  addresses.push(market);
  const marketAccount = marketAccounts[index];
  if (!marketAccount) throw new Error("Missing fetched market account");
  // Quote (collateral 0) and every listed issuer leg: its custody pool, pool
  // vault and mint (placement reads them per touched leg), plus both claim
  // mints/vaults of the collateral.
  for (let collateral = 0; collateral <= marketAccount.bases; collateral++) {
    const mint = marketAccount.mints[underlyingAsset(collateral)]!;
    const pool = poolAddress(client.config, mint, client.program);
    addresses.push(mint, pool, poolVaultAddress(pool, client.program));
    for (const owner of owners) addresses.push(assetCreditAddress(pool, owner, client.program));
    for (const branch of [0, 1]) {
      const asset = claimAsset(collateral, branch);
      addresses.push(claimAddress(market, asset, client.program), vaultAddress(market, asset, client.program));
    }
  }
  for (const owner of owners) addresses.push(walletAddress(market, owner, client.program));
}
for (const owner of owners) addresses.push(traderAddress(client.config, owner, client.program));
for (const owner of owners)
  for (const delegate of delegates)
    addresses.push(delegationAddress(client.config, owner, delegate, client.program));
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
  return result.context.slot;
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
const frozenAt = await send(
  AddressLookupTableProgram.freezeLookupTable({ lookupTable: table, authority: payer.publicKey }),
);
// RPC send services resolve tables against the rooted bank and silently drop
// transactions using entries that are not finalized yet: publish only then.
while ((await client.connection.getSlot("finalized")) <= frozenAt) await Bun.sleep(500);
console.log(
  JSON.stringify({
    event: "lookup-table-frozen",
    address: table.toBase58(),
    entries: unique.length,
    configure: ["SOLANA_ADDRESS_LOOKUP_TABLES", "NEXT_PUBLIC_SOLANA_ADDRESS_LOOKUP_TABLES"],
  }),
);
