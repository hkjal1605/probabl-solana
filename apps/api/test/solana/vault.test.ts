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
    asset: String(market.mints[2]),
    tokenId: "2",
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
    [client.deposit(new PublicKey(id), owner, market.mints[2]!, 2, 20n)],
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
