import { expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { MintLayout, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { bn, coder, SolanaClient, unwrap, walletAddress, type MarketAccount } from "../src/index";

test("funding uses two batches, validates identities, and handles missing SPL/2022 ATAs", async () => {
  for (const tokenProgram of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const pk = () => PublicKey.unique();
    const config = pk(), owner = pk(), id = pk(), program = pk();
    const zeros = () => Array(32).fill(0), amounts = (n: number) => Array.from({ length: n }, () => bn(0));
    const market: MarketAccount = {
      config, id: zeros(), mints: Array.from({ length: 6 }, pk), decimals: [6,6], state: 2, vaults_initialized: 63,
      sequence: amounts(2), open_notional: bn(0), credits: amounts(6), escrow: amounts(6), backing: amounts(2), fees: amounts(2),
      resolution_commitment: zeros(), payouts: [0,0], evidence: zeros(), evidence_uri: "", resolved_at: bn(0), bump: 0,
      terms: { condition: zeros(), yes_index: 1, no_index: 2, rules_hash: zeros(), metadata_hash: zeros(), metadata_uri: "",
        trading_open: bn(0), trading_cutoff: bn(4000000000), tick: bn(1), step: bn(1), min_notional: bn(1),
        max_quantity: bn(1000000), max_order: bn(1000000), max_wallet: bn(1000000), max_market: bn(1000000) },
    };
    const mintData = Buffer.alloc(MintLayout.span);
    MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 0n,
      decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, mintData);
    const data = await coder.accounts.encode("Market", market);
    const walletData = await coder.accounts.encode("Wallet", { market: id, owner, balances: [bn(0), bn(100), ...amounts(4)], open_notional: bn(0), bump: 0 });
    const client = new SolanaClient({ rpcUrl: "http://127.0.0.1:8899", genesisHash: "test", config: String(config), programId: String(program) });
    let calls = 0, corrupt = false, funded = false;
    client.connection.getMultipleAccountsInfoAndContext = async (keys, options) => {
      calls++;
      if (calls % 2 === 0) expect(options).toMatchObject({ minContextSlot: 100 });
      return { context: { slot: 100 }, value: keys.map((k) => k.equals(id) ? {
        data, owner: corrupt ? owner : program, lamports: 1, executable: false, rentEpoch: 0,
      } : k.equals(market.mints[1]!) ? {
        data: mintData, owner: tokenProgram, lamports: 1, executable: false, rentEpoch: 0,
      } : funded && k.equals(walletAddress(id, owner, program)) ? {
        data: walletData, owner: program, lamports: 1, executable: false, rentEpoch: 0,
      } : null) };
    };
    const order = { maker: String(owner), recipient: String(owner), marketId: String(id), salt: "0x" + "00".repeat(32),
      quantity: "100", limitPriceRawX18: "1000000000000000000", expiry: "2000", nonce: "0", maxFeeBps: 0, branch: 0, side: 0, fundingKind: 0, tif: 0 };
    const result = await client.funding(order);
    expect(calls).toBe(2);
    expect(result.depositAmount).toBe("100");
    expect(result.balanceSufficient).toBe(false);
    expect(unwrap(result.approvalCall!, program)).toHaveLength(2);
    corrupt = true;
    await expect(client.funding(order)).rejects.toThrow("foreign market");
    corrupt = false; funded = true; calls = 0;
    const covered = await client.funding(order);
    expect(calls).toBe(1);
    expect(covered.approvalCall).toBeNull();
    expect(covered.balanceSufficient).toBe(true);
  }
});
