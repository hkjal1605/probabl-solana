/** Local-only generated fixture. Never reads a default wallet or source-repo credentials.
 *
 * Deploys a multi-issuer localnet: one quote (classic SPL, or a fee-bearing
 * Token-2022 mint with SOLANA_TEST_TOKEN_2022=1) and three mock NVDA issuer
 * tokens replicating the mainnet xStocks / Ondo / Remora Token-2022
 * configurations (scripts/solana/mock-issuers.ts). Markets are created with
 * the admin SDK flow: create_market (quote only) → initializeMarketVaults
 * (custody pools with exact issuer admission, add_base per leg, claims) → open. */
import { mkdir } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  allLegs,
  assetCreditAddress,
  bn,
  claimAddress,
  configAddress,
  digest,
  hex,
  legBit,
  liveLegs,
  marketAddress,
  orderId,
  planOrder,
  poolAddress,
  poolVaultAddress,
  SolanaClient,
  traderAddress,
  underlyingAsset,
  unwrap,
  vaultAddress,
  walletAddress,
  type OrderWire,
} from "@conditional-stocks/solana-client";
import { initializeMarketVaults, lifecycleTransaction } from "@conditional-stocks/solana-client/admin";
import {
  createInitializeMetadataPointerInstruction,
  createInitializeMint2Instruction,
  createInitializeTransferFeeConfigInstruction,
  ExtensionType,
  getMintLen,
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { createInitializeInstruction, pack } from "@solana/spl-token-metadata";
import { type IssuerProfile, issueInstructions, mockIssuerInstructions } from "./mock-issuers.ts";

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
const token2022 = process.env.SOLANA_TEST_TOKEN_2022 === "1";
const connection = new Connection(rpc, "confirmed"),
  admin = Keypair.generate(),
  alice = Keypair.generate(),
  bob = Keypair.generate();
for (const signer of [admin, alice, bob]) {
  const signature = await connection.requestAirdrop(signer.publicKey, 50_000_000_000);
  const latest = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction({ signature, ...latest }, "confirmed");
}
const client = new SolanaClient({
  rpcUrl: rpc,
  config: configAddress(admin.publicKey).toBase58(),
  genesisHash: await connection.getGenesisHash(),
});
const send = async (instructions: TransactionInstruction[], payer = admin, others: Keypair[] = []) => {
  const latest = await connection.getLatestBlockhash("confirmed"),
    transaction = new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: latest.blockhash,
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...instructions],
      }).compileToV0Message(),
    );
  transaction.sign([payer, ...others]);
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  const confirmed = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (confirmed.value.err) throw new Error(JSON.stringify(confirmed.value.err));
  return signature;
};

// Quote: classic 6-decimal SPL, or Token-2022 with a 1% transfer fee.
const quoteProgram = token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
const quoteSigner = Keypair.generate(),
  quote = quoteSigner.publicKey,
  quoteSpace = token2022 ? getMintLen([ExtensionType.TransferFeeConfig]) : MINT_SIZE;
await send(
  [
    SystemProgram.createAccount({
      fromPubkey: admin.publicKey,
      newAccountPubkey: quote,
      space: quoteSpace,
      lamports: await connection.getMinimumBalanceForRentExemption(quoteSpace),
      programId: quoteProgram,
    }),
    ...(token2022
      ? [
          createInitializeTransferFeeConfigInstruction(
            quote,
            admin.publicKey,
            admin.publicKey,
            100,
            1_000_000n,
            quoteProgram,
          ),
        ]
      : []),
    createInitializeMint2Instruction(quote, 6, admin.publicKey, null, quoteProgram),
  ],
  admin,
  [quoteSigner],
);

// Mock NVDA issuer tokens (xStocks 8 dec, Ondo 9, Remora 9) replicating the
// mainnet Token-2022 configurations. The admin is the mock issuer authority
// (mint, freeze, pause, multiplier). With SOLANA_TEST_TOKEN_2022=1 a fourth,
// fee-bearing Token-2022 leg (generic 2.5% transfer fee, no issuer controls) is
// listed as well: real issuer mints use ConfidentialTransferMint, which
// Token-2022 does not combine with a plain transfer fee.
interface Issuer {
  profile: IssuerProfile | "fee-bearing";
  symbol: string;
  mint: PublicKey;
  decimals: number;
  admitted: number;
  program: string;
}
const issuers: Issuer[] = [];
for (const profile of ["xstocks", "ondo", "remora"] as const) {
  const issuer = await mockIssuerInstructions({
    connection,
    payer: admin.publicKey,
    authority: admin.publicKey,
    profile,
    ticker: "NVDA",
  });
  await send(issuer.instructions, admin, [issuer.mint]);
  issuers.push({
    profile,
    symbol: issuer.symbol,
    mint: issuer.mint.publicKey,
    decimals: issuer.decimals,
    admitted: issuer.admitted,
    program: issuer.program.toBase58(),
  });
}
if (token2022) {
  const signer = Keypair.generate(),
    mint = signer.publicKey,
    metadata = {
      mint,
      updateAuthority: admin.publicKey,
      name: "NVDA (mock fee-bearing Token-2022)",
      symbol: "NVDAfee",
      uri: "",
      additionalMetadata: [] as [string, string][],
    },
    fixed = [ExtensionType.MetadataPointer, ExtensionType.TransferFeeConfig];
  await send(
    [
      SystemProgram.createAccount({
        fromPubkey: admin.publicKey,
        newAccountPubkey: mint,
        space: getMintLen(fixed),
        lamports: await connection.getMinimumBalanceForRentExemption(
          getMintLen(fixed, { [ExtensionType.TokenMetadata]: pack(metadata).length }),
        ),
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeMetadataPointerInstruction(mint, admin.publicKey, mint, TOKEN_2022_PROGRAM_ID),
      createInitializeTransferFeeConfigInstruction(
        mint,
        admin.publicKey,
        admin.publicKey,
        250,
        10n ** 12n,
        TOKEN_2022_PROGRAM_ID,
      ),
      createInitializeMint2Instruction(mint, 9, admin.publicKey, null, TOKEN_2022_PROGRAM_ID),
      createInitializeInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        metadata: mint,
        updateAuthority: admin.publicKey,
        mint,
        mintAuthority: admin.publicKey,
        name: metadata.name,
        symbol: metadata.symbol,
        uri: "",
      }),
    ],
    admin,
    [signer],
  );
  issuers.push({
    profile: "fee-bearing",
    symbol: metadata.symbol,
    mint,
    decimals: 9,
    admitted: 0,
    program: TOKEN_2022_PROGRAM_ID.toBase58(),
  });
}

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
  // The quote pool must exist before create_market; it admits no issuer controls.
  client.initializePool(quote, admin.publicKey, quoteProgram, 0),
]);
const quoteDecimals = 6;
for (const owner of [alice, bob]) {
  await send(
    issueInstructions(quote, admin.publicKey, admin.publicKey, owner.publicKey, 1_000_000_000_000n, quoteDecimals, quoteProgram),
  );
  for (const issuer of issuers)
    await send(
      issueInstructions(
        issuer.mint,
        admin.publicKey,
        admin.publicKey,
        owner.publicKey,
        10n ** BigInt(issuer.decimals + 6), // one million whole tokens
        issuer.decimals,
        TOKEN_2022_PROGRAM_ID,
      ),
    );
}

const [xstocks, ondo, remora, feeBearing] = issuers.map((issuer) => issuer.mint) as [
  PublicKey,
  PublicKey,
  PublicKey,
  PublicKey | undefined,
];
// Market 0 lists three issuer legs; market 1 a different pair (Remora and the
// fee-bearing leg in Token-2022 mode, so every mock mint is listed somewhere).
const marketLegs = feeBearing
  ? [
      [xstocks, ondo, feeBearing],
      [remora, feeBearing],
    ]
  : [
      [xstocks, ondo, remora],
      [xstocks, ondo],
    ];
const markets: string[] = [];
for (const [example, legs] of marketLegs.entries()) {
  const id = digest("mock-market:" + example),
    market = marketAddress(client.config, id, client.program),
    now = Math.floor(Date.now() / 1000),
    uri = "ipfs://localnet-mock-market-" + example,
    quotePool = poolAddress(client.config, quote, client.program);
  // Quantities are share units (1e-6 NVDA); prices are quote raw per share unit x 1e18.
  const terms = {
    condition: [...digest("mock-external-condition:" + example)],
    yes_index: 1,
    no_index: 2,
    rules_hash: [...digest("Local test only; no real-world stock rights")],
    metadata_hash: [...digest(uri)],
    metadata_uri: uri,
    trading_open: bn(now - 10),
    trading_cutoff: bn(now + 7 * 86400),
    share_decimals: 6,
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
        quote_mint: quote,
        quote_pool: quotePool,
        quote_vault: poolVaultAddress(quotePool, client.program),
        market,
        system_program: SystemProgram.programId,
      },
    ),
  ]);
  // Lists every issuer leg (pool with exact admission when missing, add_base),
  // then initializes the quote and leg claim mints.
  for (const tx of await initializeMarketVaults(
    client,
    market.toBase58(),
    admin.publicKey.toBase58(),
    legs.map(String),
  ))
    await send(unwrap(tx, client.program));
  await send(
    unwrap(
      lifecycleTransaction(client.deployment, admin.publicKey.toBase58(), market.toBase58(), 0),
      client.program,
    ),
  );
  for (const owner of [alice, bob]) await send([client.initializeWallet(market, owner.publicKey, admin.publicKey)]);
  markets.push(market.toBase58());
}

// Protocol-wide credit: alice holds issuer inventory, bob holds cash.
for (const issuer of issuers)
  await send(
    [
      (await client.depositForCredit(new PublicKey(markets[0]!), alice.publicKey, issuer.mint, 3, 100n * 10n ** BigInt(issuer.decimals)))
        .instruction,
    ],
    alice,
  );
for (const owner of [alice, bob])
  await send(
    [(await client.depositForCredit(new PublicKey(markets[0]!), owner.publicKey, quote, 0, 100_000_000_000n)).instruction],
    owner,
  );

// Resting liquidity: alice asks 10 shares of every leg on the YES (5/share) and
// NO (3/share) books, funded from pool credit; bob bids 2/share for any leg.
const now = BigInt(Math.floor(Date.now() / 1000));
const place = async (order: OrderWire, owner: Keypair) => {
  const market = await client.market(new PublicKey(order.marketId));
  const plan = planOrder({
    order,
    candidates: [],
    now,
    step: BigInt(market.terms.step.toString()),
    nextSequence: BigInt(market.sequence[order.branch]!.toString()),
    makerFeeBps: 0,
    takerFeeBps: 0,
    program: client.program,
    legs: await liveLegs(connection, market, client.config, client.program),
  });
  await send([client.placement(order, plan, market)], owner);
  console.info("Resting mock order", orderId(order, client.program));
};
for (const [index, id] of markets.entries()) {
  const legs = marketLegs[index]!;
  const order = (owner: Keypair, side: 0 | 1, branch: number, bases: number, price: bigint, label: string): OrderWire => ({
    maker: owner.publicKey.toBase58(),
    recipient: owner.publicKey.toBase58(),
    marketId: id,
    salt: hex(digest(`initial-maker:${index}:${label}`)),
    quantity: "10000000",
    limitPriceRawX18: String(price),
    expiry: String(now + 86400n),
    nonce: "0",
    maxFeeBps: 0,
    branch,
    side,
    fundingKind: 0,
    tif: 0,
    bases,
  });
  for (let c = 1; c <= legs.length; c++)
    for (const branch of [0, 1])
      await place(order(alice, 1, branch, legBit(c), (branch === 0 ? 5n : 3n) * 10n ** 18n, `ask:${c}:${branch}`), alice);
  await place(order(bob, 0, 0, allLegs(legs.length), 2n * 10n ** 18n, "bid:0"), bob);
}

// Shared frozen address table: quote and every leg's pool, pool vault and
// mint, all 12 claim mints/vaults of listed collaterals, participants.
const [createTable, table] = AddressLookupTableProgram.createLookupTable({
  authority: admin.publicKey,
  payer: admin.publicKey,
  recentSlot: await connection.getSlot("finalized"),
});
await send([createTable]);
const addresses: PublicKey[] = [
  client.config,
  client.program,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  SystemProgram.programId,
  ComputeBudgetProgram.programId,
];
for (const mint of [quote, ...issuers.map((issuer) => issuer.mint)]) {
  const pool = poolAddress(client.config, mint, client.program);
  addresses.push(mint, pool, poolVaultAddress(pool, client.program));
  for (const owner of [alice, bob]) addresses.push(assetCreditAddress(pool, owner.publicKey, client.program));
}
for (const owner of [alice, bob]) addresses.push(traderAddress(client.config, owner.publicKey, client.program));
for (const [index, id] of markets.entries()) {
  const market = new PublicKey(id);
  addresses.push(market, ...[alice, bob].map((o) => walletAddress(market, o.publicKey, client.program)));
  for (let c = 0; c <= marketLegs[index]!.length; c++)
    for (const asset of [underlyingAsset(c) + 1, underlyingAsset(c) + 2])
      addresses.push(claimAddress(market, asset, client.program), vaultAddress(market, asset, client.program));
}
const unique = [...new Map(addresses.map((a) => [a.toBase58(), a])).values()];
for (let i = 0; i < unique.length; i += 20)
  await send([
    AddressLookupTableProgram.extendLookupTable({
      lookupTable: table,
      authority: admin.publicKey,
      payer: admin.publicKey,
      addresses: unique.slice(i, i + 20),
    }),
  ]);
await send([AddressLookupTableProgram.freezeLookupTable({ lookupTable: table, authority: admin.publicKey })]);
// The RPC send service resolves lookup tables against the rooted bank and drops
// transactions whose table entries are not yet finalized: wait for the root.
const frozenAt = await connection.getSlot("confirmed");
while ((await connection.getSlot("finalized")) <= frozenAt) await Bun.sleep(250);
const rooted = (await connection.getAddressLookupTable(table, { commitment: "finalized" })).value;
if (!rooted || rooted.state.authority !== undefined || rooted.state.addresses.length !== unique.length)
  throw new Error("Lookup table is not finalized and frozen");

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
  YELLOWSTONE_GRPC_URL: process.env.YELLOWSTONE_GRPC_URL ?? "http://127.0.0.1:10000",
  // The API reads the indexer's loopback relay instead of its own stream.
  INDEXER_RELAY_URL: "http://127.0.0.1:42070",
  NEXT_PUBLIC_SOLANA_RPC_URL: rpc,
  NEXT_PUBLIC_SOLANA_CONFIG: client.config.toBase58(),
  NEXT_PUBLIC_SOLANA_PROGRAM_ID: client.program.toBase58(),
  NEXT_PUBLIC_SOLANA_GENESIS_HASH: client.deployment.genesisHash,
  NEXT_PUBLIC_SOLANA_ADDRESS_LOOKUP_TABLES: String(table),
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
      quoteMint: quote.toBase58(),
      quoteProgram: quoteProgram.toBase58(),
      shareDecimals: 6,
      // Issuer legs of markets[0], in leg order (1-3 mints, listable together).
      baseMints: marketLegs[0]!.map(String),
      // Every mock issuer token (Token-2022 mode adds a fee-bearing leg).
      issuers: issuers.map((issuer) => ({ ...issuer, mint: issuer.mint.toBase58() })),
      issuerAuthority: admin.publicKey.toBase58(),
      markets,
      marketLegs: Object.fromEntries(markets.map((id, i) => [id, marketLegs[i]!.map(String)])),
      admin: admin.publicKey.toBase58(),
      alice: alice.publicKey.toBase58(),
      bob: bob.publicKey.toBase58(),
    },
    null,
    2,
  ),
);
console.info("Local-only deployment created at " + destination.pathname);
