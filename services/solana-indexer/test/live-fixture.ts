/** Fixtures for the live (Geyser-streamed) index: encoded program accounts,
 * SPL mint/vault images, a fake RPC connection and a fake Yellowstone client. */
import { EventEmitter } from "node:events";
import { AccountLayout, MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { AccountInfo } from "@solana/web3.js";
import {
  PublicKey,
  bn,
  delegationAddress,
  encodeAccount,
  orderId,
  orderWire,
  poolAddress,
  poolVaultAddress,
  traderAddress,
  type OrderAccount,
} from "@conditional-stocks/solana-client";
import type { AccountVersion } from "../src/live/accounts.ts";
import type { GeyserClient, GeyserStream } from "../src/live/geyser.ts";
import type { Snapshot } from "../src/projection.ts";
import { custodyFixture } from "./custody-fixture.ts";

export function mintInfo(decimals: number): AccountInfo<Buffer> {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 0n,
      decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  return { data, owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1, rentEpoch: 0 };
}

export function vaultInfo(mint: PublicKey, owner: PublicKey, frozen = false): AccountInfo<Buffer> {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount: 0n,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: frozen ? 2 : 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return { data, owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1, rentEpoch: 0 };
}

export function orderFixture(
  market: string,
  owner: PublicKey,
  program: PublicKey,
  input: { side?: number; bases?: number; salt?: number; delegate?: PublicKey } = {},
): [string, OrderAccount] {
  const salt = input.salt ?? 1;
  const o = {
    market: new PublicKey(market),
    owner,
    delegate: input.delegate ?? PublicKey.default,
    remaining: bn(10),
    filled: bn(0),
    reserved: bn(0),
    open_notional: bn(0),
    sequence: bn(salt),
    fee_carry: 0,
    status: 1,
    bump: 0,
    terms: {
      recipient: owner,
      salt: Array(32).fill(salt),
      quantity: bn(10),
      price: bn(10n ** 17n),
      expiry: bn(9_999_999_999),
      nonce: bn(0),
      max_fee_bps: 0,
      branch: 0,
      side: input.side ?? 0,
      funding: 1,
      tif: 0,
      bases: input.bases ?? 1,
    },
  } as OrderAccount;
  return [orderId(orderWire(o), program), o];
}

/** A two-market deployment (see `custodyFixture`) with one resting order, a
 * trader and a delegation, encoded as program accounts. */
export function liveFixture(legs = 2) {
  const f = custodyFixture(legs);
  const { s, config, owner } = f;
  const [marketId] = [...s.markets.keys()];
  const [id, order] = orderFixture(marketId!, owner, s.program);
  s.orders.set(id, order);
  const trader = { config, owner, minimum_nonce: bn(0), delegation_epoch: bn(0), bump: 0 };
  s.traders.set(owner.toBase58(), trader);
  const delegate = PublicKey.unique();
  const grant = {
    config,
    owner,
    delegate,
    market: new PublicKey(marketId!),
    epoch: bn(0),
    expires_at: bn(9_999_999_999),
    max_order_quote: bn(1000),
    remaining_quote: bn(1000),
    max_fee_bps: 0,
    permissions: 1,
    revoked: false,
    bump: 0,
  };
  const grantAddress = delegationAddress(config, owner, delegate, s.program).toBase58();
  s.delegations!.set(grantAddress, grant);
  const client = { config, program: s.program };
  return { ...f, marketId: marketId!, orderId: id, order, trader, grant, grantAddress, delegate, client };
}

/** Program account images of a snapshot, keyed by address. */
export function programAccounts(s: Snapshot, config: PublicKey) {
  const out = new Map<string, Buffer>();
  out.set(config.toBase58(), encodeAccount("Config", s.config));
  for (const [k, v] of s.pools) out.set(k, encodeAccount("AssetPool", v));
  for (const [k, v] of s.credits) out.set(k, encodeAccount("AssetCredit", v));
  for (const [k, v] of s.markets) out.set(k, encodeAccount("Market", v));
  for (const [k, v] of s.wallets) out.set(k, encodeAccount("Wallet", v));
  for (const [k, v] of s.orders) out.set(k, encodeAccount("Order", v));
  for (const v of s.traders.values()) out.set(traderAddress(config, v.owner, s.program).toBase58(), encodeAccount("Trader", v));
  for (const [k, v] of s.delegations ?? []) out.set(k, encodeAccount("TradingDelegate", v));
  return out;
}

/** Issuer mints and pool vaults of a deployment's listed legs. */
export function legInfos(bases: PublicKey[], config: PublicKey, program: PublicKey, frozen: number[] = []) {
  const out = new Map<string, AccountInfo<Buffer>>();
  for (const [i, mint] of bases.entries()) {
    const pool = poolAddress(config, mint, program);
    out.set(mint.toBase58(), mintInfo(6));
    out.set(poolVaultAddress(pool, program).toBase58(), vaultInfo(mint, pool, frozen.includes(i)));
  }
  return out;
}

export const version = (
  slot: number,
  data: Buffer,
  owner: string,
  writeVersion = 1n,
  lamports = 1n,
): AccountVersion => ({ slot, writeVersion, owner, lamports, data });

/** RPC connection backed by mutable maps. */
export function fakeConnection(input: {
  program: PublicKey;
  slot: number;
  programAccounts: Map<string, Buffer>;
  others: Map<string, AccountInfo<Buffer>>;
}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const connection = {
    slot: input.slot,
    programAccounts: input.programAccounts,
    others: input.others,
    failProgramAccounts: 0,
    short: false,
    calls,
    async getProgramAccounts(program: PublicKey, options: unknown) {
      calls.push({ method: "getProgramAccounts", args: [program, options] });
      if (connection.failProgramAccounts > 0) {
        connection.failProgramAccounts--;
        throw new Error("rpc unavailable");
      }
      return {
        context: { slot: connection.slot },
        value: [...connection.programAccounts].map(([address, data]) => ({
          pubkey: new PublicKey(address),
          account: { data, owner: input.program, lamports: 1, executable: false },
        })),
      };
    },
    async getMultipleAccountsInfo(keys: PublicKey[], options: unknown) {
      calls.push({ method: "getMultipleAccountsInfo", args: [keys, options] });
      const values = keys.map((k) => connection.others.get(k.toBase58()) ?? null);
      return connection.short ? values.slice(1) : values;
    },
  };
  return connection;
}

export class FakeStream extends EventEmitter {
  writes: Record<string, unknown>[] = [];
  ended = false;
  failWrite: Error | undefined;
  write(request: unknown, callback?: (error?: Error | null) => void) {
    this.writes.push(request as Record<string, unknown>);
    queueMicrotask(() => callback?.(this.failWrite ?? null));
    return true;
  }
  end() {
    this.ended = true;
  }
  /** Sends one raw SubscribeUpdate. */
  push(update: Record<string, unknown>) {
    this.emit("data", update);
  }
}

/** A Yellowstone client factory recording every client and stream. */
export function fakeGeyser(input: { firstAvailable?: string | undefined } = {}) {
  const streams: FakeStream[] = [];
  const state = {
    streams,
    clients: 0,
    /** Compression requested by each client, in order. */
    compression: [] as boolean[],
    /** Fail `subscribe()` with this error while compression is requested. */
    rejectCompression: undefined as Error | undefined,
    firstAvailable: "firstAvailable" in input ? input.firstAvailable : "18446744073709551615",
    failConnect: 0,
    failSubscribe: 0,
    /** Resolves `subscribe()` only when released (to test stop during connect). */
    hold: undefined as undefined | Promise<void>,
    get stream() {
      return streams.at(-1);
    },
  };
  const factory = ({ compression }: { compression: boolean }): GeyserClient => {
    state.clients++;
    state.compression.push(compression);
    return {
      connect: async () => {
        if (state.failConnect > 0) {
          state.failConnect--;
          throw new Error("connect refused");
        }
      },
      subscribeReplayInfo: async () => ({ firstAvailable: state.firstAvailable }),
      subscribe: async () => {
        if (state.hold) await state.hold;
        if (compression && state.rejectCompression) throw state.rejectCompression;
        if (state.failSubscribe > 0) {
          state.failSubscribe--;
          throw new Error("subscribe refused");
        }
        const stream = new FakeStream();
        streams.push(stream);
        return stream as unknown as GeyserStream;
      },
    };
  };
  return { factory, state };
}

/** Raw Yellowstone update builders. */
export const updates = {
  account(address: string, slot: number, owner: PublicKey, data: Buffer, writeVersion = 1, lamports = 1) {
    return {
      account: {
        slot: String(slot),
        account: {
          pubkey: new PublicKey(address).toBytes(),
          owner: owner.toBytes(),
          lamports: String(lamports),
          writeVersion: String(writeVersion),
          data: new Uint8Array(data),
        },
      },
    };
  },
  slot(slot: number, status: number, parent?: number) {
    return { slot: { slot: String(slot), status, ...(parent !== undefined ? { parent: String(parent) } : {}) } };
  },
  blockTime(slot: number, timestamp: number) {
    return { blockMeta: { slot: String(slot), blockTime: { timestamp: String(timestamp) } } };
  },
};

export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
export async function until(condition: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
