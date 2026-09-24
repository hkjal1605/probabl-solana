import { expect, test } from "bun:test";
import { Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";
import { AccountLayout, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  bn,
  claimAsset,
  encodeAccount,
  type SolanaClient,
} from "@conditional-stocks/solana-client";
import { marketFixture } from "./custody-fixture";
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
function fixture(count: number, legs = 1) {
  const owner = pk(),
    program = pk(),
    config = pk();
  const markets = Array.from({ length: count }, () => {
    const market = pk();
    return [
      market.toBase58(),
      marketFixture({
        config,
        market,
        program,
        quote: pk(),
        bases: Array.from({ length: legs }, pk),
        decimals: [6, 8, 9, 9],
      }),
    ] as const;
  });
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
  f.markets[1]![1].vaults_initialized = 1;
  const credit = 9007199254740993n,
    external = 23n;
  const balances = Array.from({ length: 12 }, () => bn(0));
  balances[1] = bn(3);
  balances[2] = bn(4);
  balances[4] = bn(credit);
  balances[5] = bn(2);
  const wallet = encodeAccount("Wallet", {
    market: new PublicKey(id),
    owner: f.owner,
    balances,
    open_notional: bn(0),
    bump: 0,
  });
  f.set(() => ({
    context: { slot: 102 },
    value: [info(f.program, wallet), null, null, token(m.mints[4]!, f.owner, external), null],
  }));
  const result = await readPositions(f.client, f.snapshot, f.owner);
  expect(f.calls[0]!.keys).toHaveLength(5);
  expect(result.positions).toEqual([
    {
      marketId: id,
      conditionId: id,
      redeemable: false,
      shareDecimals: 6,
      quoteTokenDecimals: 6,
      quoteYes: "3",
      quoteNo: "4",
      bases: [
        {
          collateral: 1,
          mint: m.mints[3]!.toBase58(),
          decimals: 8,
          yes: (credit + external).toString(),
          no: "2",
        },
      ],
      protocolVersion: 3,
    },
  ]);
});
test("multi-leg positions report each issuer's claims separately and skip legs without claims", async () => {
  const f = fixture(1, 3),
    [id, m] = f.markets[0]!;
  // Leg 3 is listed, but its claim mints are not initialized yet.
  m.vaults_initialized &= ~((1 << claimAsset(3, 0)) | (1 << claimAsset(3, 1)));
  const balances = Array.from({ length: 12 }, () => bn(0));
  balances[claimAsset(2, 1)] = bn(70);
  const wallet = encodeAccount("Wallet", {
    market: new PublicKey(id),
    owner: f.owner,
    balances,
    open_notional: bn(0),
    bump: 0,
  });
  f.set(() => ({
    context: { slot: 101 },
    value: [
      info(f.program, wallet),
      null,
      null,
      token(m.mints[claimAsset(1, 0)]!, f.owner, 5n),
      null,
      null,
      token(m.mints[claimAsset(2, 1)]!, f.owner, 30n),
    ],
  }));
  const result = await readPositions(f.client, f.snapshot, f.owner);
  expect(f.calls[0]!.keys).toHaveLength(7);
  expect(result.positions).toEqual([
    {
      marketId: id,
      conditionId: id,
      redeemable: false,
      shareDecimals: 6,
      quoteTokenDecimals: 6,
      quoteYes: "0",
      quoteNo: "0",
      bases: [
        { collateral: 1, mint: m.mints[3]!.toBase58(), decimals: 8, yes: "5", no: "0" },
        { collateral: 2, mint: m.mints[6]!.toBase58(), decimals: 9, yes: "0", no: "100" },
      ],
      protocolVersion: 3,
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
    const wallet = encodeAccount("Wallet", {
      market: mode === "wallet-market" ? pk() : new PublicKey(id),
      owner: mode === "wallet-owner" ? pk() : f.owner,
      balances: Array.from({ length: 12 }, () => bn(0)),
      open_notional: bn(0),
      bump: 0,
    });
    const external = token(
      mode === "token-mint" ? pk() : m.mints[1]!,
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
