import { expect, test } from "bun:test";
import { Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";
import { AccountLayout, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  bn,
  coder,
  type MarketAccount,
  type SolanaClient,
} from "@conditional-stocks/solana-client";
import type { Snapshot } from "../src/projection";
import { readPositions } from "../src/positions";

const pk = () => Keypair.generate().publicKey;
const info = (owner: PublicKey, data: Buffer): AccountInfo<Buffer> => ({
  owner,
  data,
  executable: false,
  lamports: 1000,
  rentEpoch: 0,
});
function fixture(count: number) {
  const owner = pk(),
    program = pk();
  const markets = Array.from(
    { length: count },
    () =>
      [
        pk().toBase58(),
        {
          vaults_initialized: 63,
          mints: Array.from({ length: 6 }, pk),
          decimals: [8, 6],
          state: 2,
        } as MarketAccount,
      ] as const,
  );
  const snapshot = { markets: new Map(markets), slot: 100 } as Snapshot;
  const calls: { keys: PublicKey[]; config: { commitment: string; minContextSlot: number } }[] = [];
  let index = 0;
  let read: (
    start: number,
    length: number,
  ) => { context: { slot: number }; value: (AccountInfo<Buffer> | null)[] } = (_, length) => ({
    context: { slot: 101 },
    value: Array(length).fill(null),
  });
  const client = {
    program,
    connection: {
      getMultipleAccountsInfoAndContext: async (
        keys: PublicKey[],
        config: { commitment: string; minContextSlot: number },
      ) => {
        calls.push({ keys, config });
        const start = index;
        index += keys.length;
        return read(start, keys.length);
      },
    },
  } as unknown as Pick<SolanaClient, "program" | "connection">;
  return {
    client,
    snapshot,
    owner,
    program,
    calls,
    markets,
    set: (next: typeof read) => {
      read = next;
    },
  };
}
function token(mint: PublicKey, owner: PublicKey, amount: bigint) {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return info(TOKEN_PROGRAM_ID, data);
}
test("all three market positions fit into one finalized RPC, without synthetic nonzero balances", async () => {
  const f = fixture(3);
  const result = await readPositions(f.client, f.snapshot, f.owner);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.keys).toHaveLength(15);
  expect(f.calls[0]!.config).toEqual({ commitment: "finalized", minContextSlot: 100 });
  expect(result.positions).toEqual([]);
  expect(result.blockNumber).toBe("101");
});
test("batching never exceeds 100 accounts, including the last partial market batch", async () => {
  const f = fixture(41);
  await readPositions(f.client, f.snapshot, f.owner);
  expect(f.calls.map((c) => c.keys.length)).toEqual([100, 100, 5]);
  expect(new Set(f.calls.flatMap((c) => c.keys.map((k) => k.toBase58()))).size).toBe(205);
});
test("credit and external claims sum exactly beyond JS safe integers; incomplete vaults are skipped", async () => {
  const f = fixture(2),
    [id, m] = f.markets[0]!;
  f.markets[1]![1].vaults_initialized = 3;
  const credit = 9007199254740993n,
    external = 23n;
  const wallet = await coder.accounts.encode("Wallet", {
    market: new PublicKey(id),
    owner: f.owner,
    balances: [bn(0), bn(0), bn(credit), bn(2), bn(3), bn(4)],
    open_notional: bn(0),
    bump: 0,
  });
  f.set(() => ({
    context: { slot: 102 },
    value: [info(f.program, wallet), token(m.mints[2]!, f.owner, external), null, null, null],
  }));
  const result = await readPositions(f.client, f.snapshot, f.owner);
  expect(f.calls[0]!.keys).toHaveLength(5);
  expect(result.positions).toEqual([
    {
      marketId: id,
      conditionId: id,
      stockYes: (credit + external).toString(),
      stockNo: "2",
      quoteYes: "3",
      quoteNo: "4",
      redeemable: false,
      baseTokenDecimals: 8,
      quoteTokenDecimals: 6,
      protocolVersion: 2,
      priceFormat: "raw-unit-ratio-x18",
    },
  ]);
});
test("missing accounts are zero, but incomplete responses or an older bank fail the whole read", async () => {
  for (const mode of ["short", "old", "network"] as const) {
    const f = fixture(1);
    f.set(() => {
      if (mode === "network") throw new Error("RPC offline");
      return {
        context: { slot: mode === "old" ? 99 : 100 },
        value: Array(mode === "short" ? 4 : 5).fill(null),
      };
    });
    await expect(readPositions(f.client, f.snapshot, f.owner)).rejects.toThrow();
  }
});
test("substituted wallet owners, markets, programs and external token identities fail closed", async () => {
  for (const mode of [
    "wallet-owner",
    "wallet-market",
    "wallet-program",
    "token-owner",
    "token-mint",
    "token-program",
  ] as const) {
    const f = fixture(1),
      [id, m] = f.markets[0]!;
    const wallet = await coder.accounts.encode("Wallet", {
      market: mode === "wallet-market" ? pk() : new PublicKey(id),
      owner: mode === "wallet-owner" ? pk() : f.owner,
      balances: Array.from({ length: 6 }, () => bn(0)),
      open_notional: bn(0),
      bump: 0,
    });
    const external = token(
      mode === "token-mint" ? pk() : m.mints[2]!,
      mode === "token-owner" ? pk() : f.owner,
      1n,
    );
    if (mode === "token-program") external.owner = TOKEN_2022_PROGRAM_ID;
    f.set(() => ({
      context: { slot: 100 },
      value: [
        info(mode === "wallet-program" ? pk() : f.program, wallet),
        external,
        null,
        null,
        null,
      ],
    }));
    await expect(readPositions(f.client, f.snapshot, f.owner)).rejects.toThrow();
  }
});
test("no initialized markets performs no RPC, and a later batch failure cannot publish partial positions", async () => {
  const empty = fixture(0);
  expect((await readPositions(empty.client, empty.snapshot, empty.owner)).positions).toEqual([]);
  expect(empty.calls).toHaveLength(0);
  const f = fixture(21);
  f.set((start, length) => {
    if (start) throw new Error("second batch failed");
    return { context: { slot: 100 }, value: Array(length).fill(null) };
  });
  await expect(readPositions(f.client, f.snapshot, f.owner)).rejects.toThrow("second batch");
});
