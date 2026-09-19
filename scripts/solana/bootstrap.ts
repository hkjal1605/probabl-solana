/** Local-only generated fixture. Never reads a default wallet or source-repo credentials. */
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve, sep } from "node:path";
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableProgram,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  getMintLen,
  createInitializeTransferFeeConfigInstruction,
  createInitializeMintInstruction,
} from "@solana/spl-token";
import {
  SolanaClient,
  configAddress,
  marketAddress,
  claimAddress,
  vaultAddress,
  walletAddress,
  poolAddress,
  poolVaultAddress,
  assetCreditAddress,
  unwrap,
  budgetedInstructions,
  digest,
  bn,
  hex,
  orderId,
  planOrder,
  type OrderWire,
} from "@conditional-stocks/solana-client";

import { initializeMarketVaults } from "@conditional-stocks/solana-client/admin";

const rpc = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
if (!["127.0.0.1", "localhost"].includes(new URL(rpc).hostname))
  throw new Error("Bootstrap is restricted to a localhost test validator");
const destination = process.env.SOLANA_FIXTURE_DIR
  ? pathToFileURL(resolve(process.env.SOLANA_FIXTURE_DIR) + sep)
  : new URL("../../.local/", import.meta.url);
await mkdir(destination, { recursive: true, mode: 0o700 });
if (await Bun.file(new URL("solana.env", destination)).exists())
  throw new Error(
    "A local deployment already exists. Reuse .local/solana.env; do not overwrite a deployment or wallet.",
  );
const connection = new Connection(rpc, "confirmed"),
  admin = Keypair.generate(),
  alice = Keypair.generate(),
  bob = Keypair.generate();
for (const signer of [admin, alice, bob])
  await connection.confirmTransaction(
    await connection.requestAirdrop(signer.publicKey, 50_000_000_000),
    "confirmed",
  );
const tokenProgram =
  process.env.SOLANA_TEST_TOKEN_2022 === "1" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
const client = new SolanaClient({
  rpcUrl: rpc,
  config: configAddress(admin.publicKey).toBase58(),
  genesisHash: await connection.getGenesisHash(),
});
const send = async (
  instructions: TransactionInstruction[],
  payer = admin,
  others: Keypair[] = [],
) => {
  const latest = await connection.getLatestBlockhash(),
    transaction = new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: latest.blockhash,
        instructions: budgetedInstructions(instructions, client.program),
      }).compileToV0Message(),
    );
  transaction.sign([payer, ...others]);
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
  });
  const confirmed = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (confirmed.value.err) throw new Error(JSON.stringify(confirmed.value.err));
  return signature;
};
async function mockMint(bps: number) {
  if (tokenProgram.equals(TOKEN_PROGRAM_ID))
    return createMint(connection, admin, admin.publicKey, null, 6);
  const mint = Keypair.generate(),
    space = getMintLen([ExtensionType.TransferFeeConfig]);
  await send(
    [
      SystemProgram.createAccount({
        fromPubkey: admin.publicKey,
        newAccountPubkey: mint.publicKey,
        space,
        lamports: await connection.getMinimumBalanceForRentExemption(space),
        programId: tokenProgram,
      }),
      createInitializeTransferFeeConfigInstruction(
        mint.publicKey,
        admin.publicKey,
        admin.publicKey,
        bps,
        1_000_000n,
        tokenProgram,
      ),
      createInitializeMintInstruction(mint.publicKey, 6, admin.publicKey, null, tokenProgram),
    ],
    admin,
    [mint],
  );
  return mint.publicKey;
}
const quote = await mockMint(100),
  base = await mockMint(250);
await send([
  client.ix(
    "initialize",
    {
      roles: {
        market_admin: admin.publicKey,
        guardian: admin.publicKey,
        resolution_admin: admin.publicKey,
      },
    },
    {
      admin: admin.publicKey,
      config: client.config,
      quote_mint: quote,
      system_program: SystemProgram.programId,
    },
  ),
]);
for (const owner of [alice, bob])
  for (const mint of [base, quote]) {
    const account = await getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      mint,
      owner.publicKey,
      false,
      "confirmed",
      undefined,
      tokenProgram,
    );
    await mintTo(
      connection,
      admin,
      mint,
      account.address,
      admin,
      1_000_000_000_000n,
      [],
      undefined,
      tokenProgram,
    );
  }
const markets: string[] = [];
for (let example = 0; example < 2; example++) {
  const id = digest("mock-market:" + example),
    market = marketAddress(client.config, id),
    now = Math.floor(Date.now() / 1000),
    uri = "ipfs://localnet-mock-market-" + example;
  const terms = {
    condition: [...digest("mock-external-condition:" + example)],
    yes_index: 1,
    no_index: 2,
    rules_hash: [...digest("Local test only; no real-world stock rights")],
    metadata_hash: [...digest(uri)],
    metadata_uri: uri,
    trading_open: bn(now - 10),
    trading_cutoff: bn(now + 7 * 86400),
    tick: bn(10n ** 16n),
    step: bn(1000),
    min_notional: bn(1),
    max_quantity: bn(1_000_000_000_000n),
    max_order: bn(1_000_000_000_000n),
    max_wallet: bn(2_000_000_000_000n),
    max_market: bn(4_000_000_000_000n),
  };
  await send([
    client.ix(
      "create_market",
      { id: [...id], terms },
      {
        admin: admin.publicKey,
        config: client.config,
        base_mint: base,
        quote_mint: quote,
        market,
        system_program: SystemProgram.programId,
      },
    ),
  ]);
  for (const tx of await initializeMarketVaults(client, String(market), String(admin.publicKey)))
    await send(unwrap(tx));
  for (const owner of [alice, bob])
    await send([client.initializeWallet(market, owner.publicKey, admin.publicKey)]);
  await send(
    [(await client.depositForCredit(market, alice.publicKey, base, 0, 100_000_000n)).instruction],
    alice,
  );
  await send([
    client.ix(
      "lifecycle",
      { action: 0, commitment: [...new Uint8Array(32)] },
      { actor: admin.publicKey, config: client.config, market },
    ),
  ]);
  for (const branch of [0, 1]) {
    const order: OrderWire = {
      maker: alice.publicKey.toBase58(),
      recipient: alice.publicKey.toBase58(),
      marketId: market.toBase58(),
      salt: hex(digest("initial-maker:" + branch)),
      quantity: "10000000",
      limitPriceRawX18: String((branch === 0 ? 5n : 3n) * 10n ** 18n),
      expiry: String(now + 86400),
      nonce: "0",
      maxFeeBps: 0,
      branch,
      side: 1,
      fundingKind: 0,
      tif: 0,
    };
    const plan = planOrder({
      order,
      candidates: [],
      now: BigInt(now),
      step: 1000n,
      nextSequence: 0n,
      makerFeeBps: 0,
      takerFeeBps: 0,
    });
    await send([client.placement(order, plan)], alice);
    console.info("Resting mock order", orderId(order));
  }
  markets.push(market.toBase58());
}
// Shared frozen address table keeps single-fill packets within Solana's limit.
const [createTable, table] = AddressLookupTableProgram.createLookupTable({
  authority: admin.publicKey,
  payer: admin.publicKey,
  recentSlot: await connection.getSlot("finalized"),
});
await send([createTable]);
const addresses = [
  ...new Map(
    [
      client.config,
      client.program,
      ...[base, quote],
      ...[base, quote].flatMap((mint) => {
        const pool = poolAddress(client.config, mint);
        return [
          pool,
          poolVaultAddress(pool),
          ...[alice, bob].map((o) => assetCreditAddress(pool, o.publicKey)),
        ];
      }),
      ...markets.flatMap((id) => {
        const m = new PublicKey(id);
        return [
          m,
          ...[alice, bob].map((o) => walletAddress(m, o.publicKey)),
          ...[2, 3, 4, 5].flatMap((a) => [claimAddress(m, a), vaultAddress(m, a)]),
        ];
      }),
    ].map((a) => [String(a), a]),
  ).values(),
];
for (let i = 0; i < addresses.length; i += 20)
  await send([
    AddressLookupTableProgram.extendLookupTable({
      lookupTable: table,
      authority: admin.publicKey,
      payer: admin.publicKey,
      addresses: addresses.slice(i, i + 20),
    }),
  ]);
await send([
  AddressLookupTableProgram.freezeLookupTable({ lookupTable: table, authority: admin.publicKey }),
]);
// Generated local fixtures contain no source credentials. Protect test private keys
// even though they hold only validator SOL and mock SPL tokens.
for (const [name, pair] of [
  ["admin", admin],
  ["alice", alice],
  ["bob", bob],
] as const)
  await Bun.write(new URL(name + ".json", destination), JSON.stringify([...pair.secretKey]), {
    mode: 0o600,
  });
const env = {
  SOLANA_RPC_URL: rpc,
  SOLANA_ADDRESS_LOOKUP_TABLES: String(table),
  SOLANA_CONFIG: client.config.toBase58(),
  SOLANA_GENESIS_HASH: client.deployment.genesisHash,
  API_AUTH_ORIGINS:
    "http://localhost:3001,http://localhost:3002,http://127.0.0.1:3001,http://127.0.0.1:3002",
  API_URL: "http://127.0.0.1:3000",
  INDEXER_URL: "http://127.0.0.1:42069",
  NEXT_PUBLIC_SOLANA_RPC_URL: rpc,
  NEXT_PUBLIC_SOLANA_CONFIG: client.config.toBase58(),
  NEXT_PUBLIC_SOLANA_PROGRAM_ID: client.program.toBase58(),
  NEXT_PUBLIC_SOLANA_GENESIS_HASH: client.deployment.genesisHash,
  NEXT_PUBLIC_SOLANA_CLUSTER_NAME: "Solana Localnet",
  NEXT_PUBLIC_SOLANA_MARKET_ADMIN: admin.publicKey.toBase58(),
  NEXT_PUBLIC_SOLANA_RESOLUTION_ADMIN: admin.publicKey.toBase58(),
};
await Bun.write(
  new URL("solana.env", destination),
  Object.entries(env)
    .map(([k, v]) => k + "=" + v)
    .join("\n") + "\n",
  { mode: 0o600 },
);
await Bun.write(
  new URL("deployment.json", destination),
  JSON.stringify(
    {
      rpcUrl: rpc,
      addressLookupTables: [String(table)],
      config: client.config.toBase58(),
      genesisHash: client.deployment.genesisHash,
      programId: client.program.toBase58(),
      baseMint: base.toBase58(),
      quoteMint: quote.toBase58(),
      markets,
      admin: admin.publicKey.toBase58(),
      alice: alice.publicKey.toBase58(),
      bob: bob.publicKey.toBase58(),
    },
    null,
    2,
  ),
);
console.info("Local-only deployment created at " + destination.pathname);
