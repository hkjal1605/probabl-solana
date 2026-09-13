import { test, expect } from "bun:test";
import { Buffer } from "buffer";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  MintLayout,
  TOKEN_PROGRAM_ID,
  getEpochFee,
  type TransferFee,
} from "@solana/spl-token";
import {
  mintExtensions,
  decodeSupportedMint,
  transferNet,
  transferGross,
  tokenProgram,
  TOKEN_2022_PROGRAM_ID,
  U64_MAX,
  SolanaClient,
  configAddress,
  coder,
  unwrap,
  envelope,
} from "../src/index.ts";

const tlv = (type: number, length = 0) => {
  const data = Buffer.alloc(4 + length);
  data.writeUInt16LE(type);
  data.writeUInt16LE(length, 2);
  return data;
};
test("mint policy explicitly classifies every extension and fails closed on unknown TLV", () => {
  for (let id = 0; id < 100; id++) {
    if ([1, 18, 19, 20, 21, 22, 23].includes(id))
      expect(mintExtensions(tlv(id))).toEqual([id]);
    else if (id === 0) expect(mintExtensions(tlv(id))).toEqual([]);
    else expect(() => mintExtensions(tlv(id))).toThrow("Unsupported");
  }
  expect(
    mintExtensions(Buffer.concat([tlv(18, 64), tlv(22, 64), Buffer.alloc(7)])),
  ).toEqual([18, 22]);
  for (const data of [
    Buffer.from([1]),
    Buffer.from([1, 0, 0]),
    tlv(18, 4).subarray(0, 7),
    Buffer.concat([tlv(18), tlv(18)]),
  ])
    expect(() => mintExtensions(data)).toThrow();
});
test("mint owner must be a canonical token program and initialized data must decode", () => {
  const address = Keypair.generate().publicKey,
    data = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 100n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  const info = {
    data,
    owner: TOKEN_PROGRAM_ID,
    lamports: 1,
    executable: false,
    rentEpoch: 0,
  };
  for (const owner of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    expect(
      decodeSupportedMint(address, { ...info, owner }).program.equals(owner),
    ).toBe(true);
    expect(tokenProgram(owner).equals(owner)).toBe(true);
  }
  expect(() => decodeSupportedMint(address, null)).toThrow();
  expect(() =>
    decodeSupportedMint(address, { ...info, owner: address }),
  ).toThrow();
  data[45] = 0;
  expect(() => decodeSupportedMint(address, info)).toThrow("initialized");
});
test("gross-up is minimal and exact across rounding, zero/capped/100% fees and u64 boundaries", () => {
  for (const bps of [0, 1, 100, 250, 9999, 10000])
    for (const maximumFee of [0n, 1n, 10n, 10_000n, U64_MAX]) {
      const fee: TransferFee = {
        epoch: 0n,
        transferFeeBasisPoints: bps,
        maximumFee,
      };
      for (const target of [
        0n,
        1n,
        2n,
        39n,
        97n,
        100n,
        10000n,
        U64_MAX / 2n,
        U64_MAX - 10n,
        U64_MAX,
      ]) {
        if (transferNet(U64_MAX, fee) < target)
          expect(() => transferGross(target, fee)).toThrow("u64");
        else {
          const gross = transferGross(target, fee);
          expect(transferNet(gross, fee)).toBe(target);
          if (gross > 0n)
            expect(transferNet(gross - 1n, fee)).toBeLessThan(target);
        }
      }
    }
  for (let n = 1n; n <= 1000n; n++) {
    const fee = {
      epoch: 0n,
      transferFeeBasisPoints: Number(n % 10001n),
      maximumFee: n % 37n,
    };
    const gross = transferGross(n, fee);
    expect(transferNet(gross, fee)).toBe(n);
    expect(transferNet(gross - 1n, fee)).toBeLessThan(n);
  }
  expect(transferGross(U64_MAX, null)).toBe(U64_MAX);
  for (const n of [-1n, U64_MAX + 1n]) {
    expect(() => transferGross(n, null)).toThrow();
    expect(() => transferNet(n, null)).toThrow();
  }
  for (const bps of [-1, 10001, NaN, 0.5])
    expect(() =>
      transferNet(1n, {
        epoch: 0n,
        maximumFee: 1n,
        transferFeeBasisPoints: bps,
      }),
    ).toThrow();
  expect(() =>
    transferNet(1n, { epoch: 0n, maximumFee: -1n, transferFeeBasisPoints: 1 }),
  ).toThrow();
});
test("fee selection switches exactly at the scheduled epoch", () => {
  const old = { epoch: 0n, maximumFee: 100n, transferFeeBasisPoints: 100 },
    next = { epoch: 5n, maximumFee: 100n, transferFeeBasisPoints: 200 };
  const config = {
    olderTransferFee: old,
    newerTransferFee: next,
    withheldAmount: 0n,
    transferFeeConfigAuthority: PublicKey.default,
    withdrawWithheldAuthority: PublicKey.default,
  };
  expect(transferNet(100n, getEpochFee(config, 4n))).toBe(99n);
  expect(transferNet(100n, getEpochFee(config, 5n))).toBe(98n);
  expect(transferNet(100n, getEpochFee(config, 6n))).toBe(98n);
});
test("Token-2022 builders bind program, program-specific ATA and signed minimum", () => {
  const owner = Keypair.generate().publicKey,
    mint = Keypair.generate().publicKey,
    market = Keypair.generate().publicKey;
  const client = new SolanaClient({
    rpcUrl: "http://127.0.0.1:8897",
    config: configAddress(owner).toBase58(),
    genesisHash: "test",
  });
  const ix = client.deposit(
    market,
    owner,
    mint,
    0,
    100n,
    TOKEN_2022_PROGRAM_ID,
    97n,
  );
  const decoded = coder.instruction.decode(ix.data)!;
  expect(decoded.name).toBe("deposit_bounded");
  expect(
    (
      decoded.data as { minimum_credit: { toString(): string } }
    ).minimum_credit.toString(),
  ).toBe("97");
  expect(ix.keys.at(-1)?.pubkey.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  expect(
    ix.keys[4]?.pubkey.equals(
      client.deposit(market, owner, mint, 0, 100n).keys[4]!.pubkey,
    ),
  ).toBe(false);
  const withdrawal = client.withdraw(
    market,
    owner,
    mint,
    0,
    100n,
    owner,
    TOKEN_2022_PROGRAM_ID,
    97n,
  );
  expect(coder.instruction.decode(withdrawal[1]!.data)?.name).toBe(
    "withdraw_bounded",
  );
  expect(unwrap(envelope(withdrawal))).toHaveLength(2);
  for (const [asset, amount, minimum] of [
    [0, -1n, 1n],
    [0, 0n, 0n],
    [0, U64_MAX + 1n, 1n],
    [0, 100n, 0n],
    [0, 100n, 101n],
    [-1, 100n, 97n],
    [6, 100n, 97n],
    [0.5, 100n, 97n],
  ] as const) {
    expect(() =>
      client.deposit(
        market,
        owner,
        mint,
        asset,
        amount,
        TOKEN_2022_PROGRAM_ID,
        minimum,
      ),
    ).toThrow("Invalid custody");
    expect(() =>
      client.withdraw(
        market,
        owner,
        mint,
        asset,
        amount,
        owner,
        TOKEN_2022_PROGRAM_ID,
        minimum,
      ),
    ).toThrow("Invalid custody");
  }
  expect(() => client.deposit(market, owner, mint, 0, 1n, owner)).toThrow(
    "not owned",
  );
});
