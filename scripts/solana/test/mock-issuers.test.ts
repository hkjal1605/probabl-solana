import { expect, test } from "bun:test";
import { decodeSupportedMint } from "@conditional-stocks/solana-client";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  type Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ISSUERS,
  type IssuerProfile,
  issuerExtensionTypes,
  issuerMetadata,
  mockIssuerInstructions,
} from "../mock-issuers.ts";

const MAINNET: Record<IssuerProfile, string> = {
  xstocks: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
  ondo: "gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo",
  remora: "ALTP6gug9wv5mFtx2tSU1YYZ1NrEc2chDdMPoJA8f8pu",
  backpack: "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb",
};
const fixture = async (address: string) => {
  const value = await Bun.file(
    `${import.meta.dir}/../../../packages/solana-client/test/fixtures/mint-${address}.json`,
  ).json();
  return decodeSupportedMint(new PublicKey(address), {
    data: Buffer.from(value.data, "base64"),
    owner: TOKEN_2022_PROGRAM_ID,
    lamports: value.lamports,
    executable: false,
  });
};

for (const profile of Object.keys(ISSUERS) as IssuerProfile[])
  test(`${profile} replica matches the mainnet mint's extension set, decimals and admission`, async () => {
    const mainnet = await fixture(MAINNET[profile]);
    expect(issuerExtensionTypes(profile)).toEqual([...mainnet.extensions].sort((a, b) => a - b));
    expect(ISSUERS[profile].decimals).toBe(mainnet.decimals);
    expect(ISSUERS[profile].admitted).toBe(mainnet.issuer.controls);
    // The mainnet extension order is replicated (TokenMetadata is always last).
    const order = mainnet.extensions.filter((type) => type !== 19);
    const built = await mockIssuerInstructions({
      connection: { getMinimumBalanceForRentExemption: async () => 1 } as unknown as Connection,
      payer: Keypair.generate().publicKey,
      authority: Keypair.generate().publicKey,
      profile,
      ticker: "NVDA",
    });
    expect(built.admitted).toBe(mainnet.issuer.controls);
    expect(built.symbol).toBe(issuerMetadata(profile, "NVDA").symbol);
    // createAccount, one init per fixed extension, InitializeMint2, TokenMetadata.
    expect(built.instructions).toHaveLength(order.length + 3);
    const payer = Keypair.generate();
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: PublicKey.default.toBase58(),
        instructions: built.instructions,
      }).compileToV0Message(),
    );
    tx.sign([payer, built.mint]);
    expect(tx.serialize().length).toBeLessThanOrEqual(1232);
  });

test("issuer replicas refuse a transfer fee next to confidential transfers", async () => {
  await expect(
    mockIssuerInstructions({
      connection: { getMinimumBalanceForRentExemption: async () => 1 } as unknown as Connection,
      payer: Keypair.generate().publicKey,
      authority: Keypair.generate().publicKey,
      profile: "xstocks",
      ticker: "NVDA",
      transferFee: { bps: 10, maximum: 1n },
    }),
  ).rejects.toThrow("ConfidentialTransferMint");
});
