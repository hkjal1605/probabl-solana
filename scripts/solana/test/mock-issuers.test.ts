import { expect, test } from "bun:test";
import { decodeSupportedMint } from "@conditional-stocks/solana-client";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { unpack } from "@solana/spl-token-metadata";
import {
  type Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { catalogToken, ISSUER_TOKEN_CATALOG } from "../../../packages/shared/src/token-catalog.ts";
import { assetInstructions, type ChainContext } from "../devnet-chain.ts";
import { ASSETS, isIssuer } from "../devnet-policy.ts";
import {
  createInitializeConfidentialTransferFeeConfigInstruction,
  ISSUERS,
  type IssuerProfile,
  issuerExtensionOrder,
  issuerExtensionTypes,
  issuerMetadata,
  mockIssuerInstructions,
} from "../mock-issuers.ts";

/** One mainnet mint per replicated issuer configuration. */
const MAINNET: Record<IssuerProfile, string> = {
  xstocks: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
  ondo: "gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo",
  prestocks: "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF",
  tessera: "oPAiAikWTaFj9RYoRFD35ccfwhnMcB3ThgBZRHSkjTZ",
  remora: "ALTP6gug9wv5mFtx2tSU1YYZ1NrEc2chDdMPoJA8f8pu",
  backpack: "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb",
};
const fixtureAccount = async (address: string) => {
  const value = await Bun.file(
    `${import.meta.dir}/../../../packages/solana-client/test/fixtures/mint-${address}.json`,
  ).json();
  return {
    data: Buffer.from(value.data, "base64"),
    owner: TOKEN_2022_PROGRAM_ID,
    lamports: value.lamports,
    executable: false,
  };
};
const fixture = async (address: string) =>
  decodeSupportedMint(new PublicKey(address), await fixtureAccount(address));
/** Token-2022 TokenMetadata stored on a mint (the last TLV entry). */
const onMintMetadata = (data: Buffer) => {
  for (let offset = 166; offset + 4 <= data.length; ) {
    const type = data.readUInt16LE(offset),
      length = data.readUInt16LE(offset + 2);
    if (type === 19) return unpack(data.subarray(offset + 4, offset + 4 + length));
    offset += 4 + length;
  }
  return undefined;
};
const rent = { getMinimumBalanceForRentExemption: async () => 1 } as unknown as Connection;

for (const profile of Object.keys(ISSUERS) as IssuerProfile[])
  test(`${profile} replica matches the mainnet mint's extension layout, decimals and admission`, async () => {
    const mainnet = await fixture(MAINNET[profile]);
    expect(issuerExtensionTypes(profile)).toEqual([...mainnet.extensions].sort((a, b) => a - b));
    // The mainnet TLV order is replicated exactly (TokenMetadata last).
    expect(issuerExtensionOrder(profile)).toEqual([...mainnet.extensions]);
    expect(ISSUERS[profile].decimals).toBe(mainnet.decimals);
    expect(ISSUERS[profile].admitted).toBe(mainnet.issuer.controls);
    const built = await mockIssuerInstructions({
      connection: rent,
      payer: Keypair.generate().publicKey,
      authority: Keypair.generate().publicKey,
      profile,
      ticker: "NVDA",
    });
    expect(built.admitted).toBe(mainnet.issuer.controls);
    // createAccount, one init per layout extension, InitializeMint2, TokenMetadata.
    expect(built.instructions).toHaveLength(mainnet.extensions.length - 1 + 3);
  });

test("replicas take the mainnet token's exact name, symbol and metadata uri", async () => {
  for (const token of ISSUER_TOKEN_CATALOG) {
    const profile = (Object.keys(ISSUERS) as IssuerProfile[]).find((p) => ISSUERS[p].issuer === token.issuer)!;
    const identity = issuerMetadata(profile, token.asset);
    expect([identity.name, identity.symbol, identity.uri, identity.mainnetMint]).toEqual([
      token.name,
      token.symbol,
      token.uri,
      token.mint,
    ]);
    expect(identity.multiplier).toBe(token.multiplier);
    expect(identity.feeBps).toBe(token.transferFeeBps);
  }
  // The on-chain metadata of each researched mainnet mint agrees with the catalog.
  for (const symbol of ["OPENAI", "SPACEX", "KALSHI", "ANTHROPIC", "tOpenAI", "tSpaceX", "tKalshi"]) {
    const token = catalogToken(symbol)!;
    const metadata = onMintMetadata((await fixtureAccount(token.mint)).data)!;
    expect([metadata.name, metadata.symbol, metadata.uri]).toEqual([token.name, token.symbol, token.uri]);
  }
  // Tickers an issuer does not publish keep an explicitly labelled mock identity.
  expect(issuerMetadata("remora", "NVDA")).toMatchObject({ name: "NVDA (mock Remora)", symbol: "NVDAr", uri: "" });
  expect(issuerMetadata("tessera", "ANTHROPIC")).toMatchObject({ symbol: "tANTHROPIC", uri: "", mainnetMint: null });
  expect(issuerMetadata("prestocks", "NVDA")).toMatchObject({ symbol: "NVDA", feeBps: 100 });
});

test("every devnet replica is created, issued and funded in one packet-sized transaction", async () => {
  const deployer = Keypair.generate();
  const ctx = { connection: rent, deployer } as unknown as ChainContext;
  const issuers = ASSETS.filter(isIssuer);
  expect(issuers.map((a): string => a.symbol).sort()).toEqual(ISSUER_TOKEN_CATALOG.map((t) => t.symbol).sort());
  for (const spec of issuers) {
    const token = catalogToken(spec.symbol)!;
    expect([spec.ticker, spec.decimals, spec.feeBps] as unknown[]).toEqual([token.asset, token.decimals, token.transferFeeBps]);
    const mint = Keypair.generate();
    const { asset, instructions } = await assetInstructions(ctx, spec, mint);
    expect([asset.name, asset.metadataSymbol, asset.metadataUri]).toEqual([token.name, token.symbol, token.uri]);
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: deployer.publicKey,
        recentBlockhash: PublicKey.default.toBase58(),
        instructions,
      }).compileToV0Message(),
    );
    tx.sign([deployer, mint]);
    expect(tx.serialize().length, spec.symbol).toBeLessThanOrEqual(1232);
  }
});

test("a fee-bearing variant of a confidential-transfer issuer adds the confidential fee config", async () => {
  const built = await mockIssuerInstructions({
    connection: rent,
    payer: Keypair.generate().publicKey,
    authority: Keypair.generate().publicKey,
    profile: "xstocks",
    ticker: "TSLA",
    transferFee: { bps: 10, maximum: 1n },
  });
  const types = issuerExtensionTypes("xstocks", true);
  expect(types).toContain(1);
  expect(types).toContain(16);
  expect(issuerExtensionOrder("xstocks", true).slice(-3)).toEqual([1, 16, 19]);
  expect(built.instructions).toHaveLength(types.length - 1 + 3);
  // Without confidential transfers only the fee is added.
  expect(issuerExtensionOrder("ondo", true)).toContain(1);
  expect(issuerExtensionTypes("tessera", true)).toEqual(issuerExtensionTypes("tessera"));
});

test("the confidential transfer fee config instruction encodes authority and ElGamal key", () => {
  const mint = Keypair.generate().publicKey,
    authority = Keypair.generate().publicKey;
  const ix = createInitializeConfidentialTransferFeeConfigInstruction(mint, authority);
  expect(ix.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  expect([...ix.data.subarray(0, 2)]).toEqual([37, 0]);
  expect(new PublicKey(ix.data.subarray(2, 34)).equals(authority)).toBe(true);
  expect(ix.data.subarray(34).toString("hex")).toBe(
    "6081d56ee42ad310ef5bc83cbd6d5e9da201c4876b9bbbfeec4c8488c6870e63",
  );
  expect(ix.keys).toEqual([{ pubkey: mint, isSigner: false, isWritable: true }]);
  expect(createInitializeConfidentialTransferFeeConfigInstruction(mint, null).data.subarray(2, 34).every((b) => b === 0)).toBe(true);
});

