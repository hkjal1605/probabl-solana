import { expect, test } from "bun:test";
import {
  envelope,
  PublicKey,
  SolanaClient,
  unwrap,
  verifyEnvelope,
} from "@conditional-stocks/solana-client";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { custodyFixture } from "../../../../services/solana-indexer/test/custody-fixture";
import { prepareVaultTransfer } from "../../src/solana/custody/vault.ts";

test("vault preparation isolates owners, market claims and globally reserved funds", async () => {
  const { s, owner, other, base, config } = custodyFixture();
  const client = new SolanaClient({
    rpcUrl: "http://127.0.0.1:8899",
    genesisHash: "test",
    config: String(config),
    programId: String(s.program),
  });
  let reads = 0;
  client.withdrawalQuote = async (_mint, amount) => {
    reads++;
    return { program: TOKEN_PROGRAM_ID, gross: amount, received: amount - 1n, fee: 1n };
  };
  const body = { scope: "global", asset: String(base), amount: "100" };
  const result = await prepareVaultTransfer(client, s, String(owner), body, "withdraw");
  expect(result.minimumReceived).toBe("99");
  expect(reads).toBe(1);
  await expect(prepareVaultTransfer(client, s, String(other), body, "withdraw")).rejects.toThrow(
    "Insufficient",
  );
  await expect(
    prepareVaultTransfer(client, s, String(owner), { ...body, amount: "101" }, "withdraw"),
  ).rejects.toThrow("Insufficient");
  await expect(
    prepareVaultTransfer(
      client,
      s,
      String(owner),
      { ...body, marketId: [...s.markets.keys()][0]! },
      "withdraw",
    ),
  ).rejects.toThrow("must not select");
  await expect(
    prepareVaultTransfer(
      client,
      s,
      String(owner),
      { ...body, asset: String(PublicKey.unique()) },
      "deposit",
    ),
  ).rejects.toThrow("not initialized");
  const [id, market] = [...s.markets][0]!;
  const [otherId] = [...s.markets][1]!;
  const claim = {
    scope: "market",
    marketId: id,
    asset: String(market.mints[4]),
    tokenId: "4",
    amount: "20",
  };
  await prepareVaultTransfer(client, s, String(owner), claim, "withdraw");
  expect(reads).toBe(1); // Claim instructions need no fee metadata RPC.
  await expect(
    prepareVaultTransfer(client, s, String(owner), { ...claim, marketId: otherId }, "withdraw"),
  ).rejects.toThrow("does not belong");
  await expect(prepareVaultTransfer(client, s, String(other), claim, "withdraw")).rejects.toThrow(
    "Insufficient",
  );
  await expect(
    prepareVaultTransfer(
      client,
      s,
      String(owner),
      { ...claim, tokenId: "0", asset: String(base) },
      "withdraw",
    ),
  ).rejects.toThrow("does not belong");
  const redeposit = await prepareVaultTransfer(client, s, String(owner), claim, "deposit");
  expect(unwrap(redeposit.transaction, client.program)).toHaveLength(1);
  const direct = envelope(
    [client.deposit(new PublicKey(id), owner, market.mints[4]!, 4, 20n)],
    client.program,
  );
  verifyEnvelope(direct, redeposit);
  const newWalletDeposit = await prepareVaultTransfer(client, s, String(other), claim, "deposit");
  expect(unwrap(newWalletDeposit.transaction, client.program)).toHaveLength(2);
  await expect(
    prepareVaultTransfer(
      client,
      s,
      String(owner),
      {
        ...claim,
        recipient: String(other),
      },
      "deposit",
    ),
  ).rejects.toThrow("Invalid market claim transfer");
  expect(reads).toBe(1);
});

test("market claim transfers accept only claim assets of listed, initialized collaterals", async () => {
  const { s, owner, bases, config } = custodyFixture(2);
  const client = new SolanaClient({
    rpcUrl: "http://127.0.0.1:8899",
    genesisHash: "test",
    config: String(config),
    programId: String(s.program),
  });
  const [id, market] = [...s.markets][0]!;
  const claim = (tokenId: string, asset = market.mints[Number(tokenId)] ?? PublicKey.default) => ({
    scope: "market",
    marketId: id,
    asset: String(asset),
    tokenId,
    amount: "5",
  });
  // Quote claims and both legs' YES/NO claims are market-wallet assets.
  for (const tokenId of ["1", "2", "4", "5", "7", "8"]) {
    const prepared = await prepareVaultTransfer(client, s, String(owner), claim(tokenId), "deposit");
    expect(unwrap(prepared.transaction, client.program)).toHaveLength(1);
  }
  // Underlying (quote 0, legs 3/6) is global pool credit; 10/11 are unlisted;
  // malformed indexes never coerce into a claim asset.
  for (const body of [
    claim("0"),
    claim("3", bases[0]),
    claim("6", bases[1]),
    claim("10", market.mints[4]),
    claim("11", market.mints[5]),
    claim("12", market.mints[4]),
    claim("4.0", market.mints[4]),
    claim(" 4", market.mints[4]),
    claim("7", market.mints[4]),
  ])
    await expect(
      prepareVaultTransfer(client, s, String(owner), body, "deposit"),
    ).rejects.toThrow("does not belong");
  // A listed leg whose claim vaults are not initialized cannot take claims yet.
  market.vaults_initialized &= ~(1 << 8);
  await expect(
    prepareVaultTransfer(client, s, String(owner), claim("8"), "deposit"),
  ).rejects.toThrow("does not belong");
  // Global scope is unchanged: every issuer pool is addressed by its mint.
  client.withdrawalQuote = async (_mint, amount) => ({
    program: TOKEN_PROGRAM_ID,
    gross: amount,
    received: amount,
    fee: 0n,
  });
  const global = await prepareVaultTransfer(
    client,
    s,
    String(owner),
    { scope: "global", asset: String(bases[1]), amount: "100" },
    "withdraw",
  );
  expect(global.scope).toBe("global");
});
