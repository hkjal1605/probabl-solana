import { expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { MintLayout, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { bn, coder, encodeAccount, SolanaClient, unwrap, walletAddress, poolAddress, assetCreditAddress, type MarketAccount } from "../src/index";
import { marketAccount } from "./market-fixture";

test("funding uses two batches, validates identities, and handles missing SPL/2022 ATAs", async () => {
  for (const tokenProgram of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const pk = () => PublicKey.unique();
    const config = pk(), owner = pk(), id = pk(), program = pk();
    const amounts = (n: number) => Array.from({ length: n }, () => bn(0));
    const market: MarketAccount = marketAccount({ config, market: id, program });
    const mintData = Buffer.alloc(MintLayout.span);
    MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 0n,
      decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, mintData);
    const data = encodeAccount("Market", market);
    const walletData = await coder.accounts.encode("Wallet", { market: id, owner, balances: amounts(12), open_notional: bn(0), bump: 0 });
    const pool = poolAddress(config, market.mints[0]!, program), credit = assetCreditAddress(pool, owner, program);
    const creditData = await coder.accounts.encode("AssetCredit", {pool,owner,available:bn(100),bump:0});
    const client = new SolanaClient({ rpcUrl: "http://127.0.0.1:8899", genesisHash: "test", config: String(config), programId: String(program) });
    let calls = 0, corrupt = false, funded = false;
    client.connection.getMultipleAccountsInfoAndContext = async (keys, options) => {
      calls++;
      if (calls % 2 === 0) expect(options).toMatchObject({ minContextSlot: 100 });
      return { context: { slot: 100 }, value: keys.map((k) => k.equals(id) ? {
        data, owner: corrupt ? owner : program, lamports: 1, executable: false, rentEpoch: 0,
      } : k.equals(market.mints[0]!) ? {
        data: mintData, owner: tokenProgram, lamports: 1, executable: false, rentEpoch: 0,
      } : funded && k.equals(credit) ? {
        data: creditData, owner: program, lamports: 1, executable: false, rentEpoch: 0,
      } : funded && k.equals(walletAddress(id, owner, program)) ? {
        data: walletData, owner: program, lamports: 1, executable: false, rentEpoch: 0,
      } : null) };
    };
    const order = { maker: String(owner), recipient: String(owner), marketId: String(id), salt: "0x" + "00".repeat(32),
      quantity: "100", limitPriceRawX18: "1000000000000000000", expiry: "2000", nonce: "0", maxFeeBps: 0, branch: 0, side: 0, fundingKind: 0, tif: 0, bases: 1 };
    const result = await client.funding(order);
    expect(calls).toBe(2);
    expect(result.depositAmount).toBe("100");
    expect(result.balanceSufficient).toBe(false);
    expect(unwrap(result.approvalCall!, program)).toHaveLength(2);
    corrupt = true;
    await expect(client.funding(order)).rejects.toThrow("foreign market");
    corrupt = false; funded = true; calls = 0;
    const covered = await client.funding(order);
    expect(calls).toBe(2);
    expect(covered.approvalCall).toBeNull();
    expect(covered.balanceSufficient).toBe(true);
  }
});
