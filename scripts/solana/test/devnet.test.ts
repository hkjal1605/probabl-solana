import { describe, test, expect } from "bun:test";
import {
  mkdtemp,
  lstat,
  readFile,
  symlink,
  chmod,
  unlink,
  rmdir,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  type AccountInfo,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  decodeMintToCheckedInstruction,
} from "@solana/spl-token";
import { configAddress } from "@conditional-stocks/solana-client";
import {
  bufferWrite,
  missingChunks,
  UPLOAD_CHUNK_BYTES,
} from "../devnet-upload.ts";
import {
  ASSETS,
  DEVNET_GENESIS,
  DEVNET_RPC,
  LOADER,
  PROGRAM_ID,
  NATIVE_MINT,
  rawAmount,
  parseDeployer,
  devnetRpc,
  assertDevnet,
  readProgram,
  verifyProgramData,
  verifyBuffer,
  uploadTransport,
  validatePlanIdentity,
  sha256,
  type DeploymentPlan,
} from "../devnet-policy.ts";
import {
  privateDirectory,
  deploymentDirectory,
  keyFile,
  writePrivate,
  writeJson,
  readJson,
  locked,
  withTemporarySigner,
} from "../devnet-store.ts";
import {
  assetPlan,
  assetInstructions,
  sendStep,
  type ChainContext,
} from "../devnet-chain.ts";
import {
  main,
  programStatus,
  journalContext,
  exportEnvironment,
  fundingPlan,
} from "../devnet.ts";

const owner = Keypair.generate();
function plan(): DeploymentPlan {
  return {
    version: 1,
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    programId: PROGRAM_ID.toBase58(),
    deployer: owner.publicKey.toBase58(),
    config: configAddress(owner.publicKey).toBase58(),
    artifactSha256: "a",
    artifactBytes: 100,
    idlSha256: "b",
    sourceSha256: {},
    assets: ASSETS.map((spec) =>
      assetPlan(
        spec,
        spec.kind === "native" ? NATIVE_MINT : Keypair.generate().publicKey,
        owner.publicKey,
      ),
    ),
  };
}
const temp = () => mkdtemp(join(tmpdir(), "probabl-pipeline-unit-"));
const account = (
  data: Buffer,
  extra: Partial<AccountInfo<Buffer>> = {},
): AccountInfo<Buffer> => ({
  data,
  owner: LOADER,
  lamports: 100,
  executable: false,
  rentEpoch: 0,
  ...extra,
});
function programAccount() {
  const data = Buffer.alloc(36);
  data.writeUInt32LE(2);
  PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], LOADER)[0]
    .toBuffer()
    .copy(data, 4);
  return account(data, { executable: true });
}
function programData(artifact = Buffer.from("ELF")) {
  const data = Buffer.alloc(45 + artifact.length + 8);
  data.writeUInt32LE(3);
  data.writeBigUInt64LE(12n, 4);
  data[12] = 1;
  owner.publicKey.toBuffer().copy(data, 13);
  artifact.copy(data, 45);
  return account(data);
}

describe("Devnet policy and private keys", () => {
  test("both key formats round-trip without a default wallet", () => {
    for (const input of [
      bs58.encode(owner.secretKey),
      JSON.stringify([...owner.secretKey]),
    ])
      expect(
        parseDeployer(" " + input + " ").publicKey.equals(owner.publicKey),
      ).toBe(true);
  });
  test("rejects malformed, truncated, non-byte and inconsistent keys without echoing input", () => {
    const changed = [...owner.secretKey];
    changed[63] = changed[63]! ^ 1;
    for (const input of [
      undefined,
      "",
      "secret-to-never-echo",
      "{bad",
      "[1,2]",
      bs58.encode(owner.secretKey.slice(0, 32)),
      JSON.stringify(changed),
      JSON.stringify(Array(64).fill(-1)),
      JSON.stringify(Array(64).fill(256)),
      JSON.stringify(Array(64).fill(0.5)),
      JSON.stringify(Array(64).fill("1")),
    ]) {
      expect(() => parseDeployer(input)).toThrow(
        "must be a valid base58 or JSON 64-byte Solana secret key",
      );
    }
  });
  test("exact decimal/u64 arithmetic", () => {
    expect(rawAmount("0.1", 9)).toBe(100_000_000n);
    expect(rawAmount("18446744073709551615", 0)).toBe((1n << 64n) - 1n);
    expect(rawAmount("0.000000001", 9)).toBe(1n);
    for (const amount of [
      "0",
      "-1",
      "1e6",
      " 1",
      "01",
      "1.",
      "0.0000000001",
      "18446744073709551616",
    ])
      expect(() => rawAmount(amount, amount.length > 19 ? 0 : 9)).toThrow();
    for (const decimals of [-1, 19, 1.1, NaN])
      expect(() => rawAmount("1", decimals)).toThrow();
  });
  test("only pinned Devnet genesis is accepted", async () => {
    await assertDevnet({ getGenesisHash: async () => DEVNET_GENESIS });
    for (const hash of ["mainnet", "testnet", "localnet", ""])
      await expect(
        assertDevnet({ getGenesisHash: async () => hash }),
      ).rejects.toThrow("non-Devnet");
  });
  test("RPC policy permits HTTPS providers, but never userinfo or a local bypass", () => {
    expect(devnetRpc()).toBe(DEVNET_RPC + "/");
    expect(devnetRpc("https://rpc.example/path?api-key=secret")).toContain(
      "api-key=secret",
    );
    for (const rpc of [
      "http://localhost:8899",
      "https://user:secret@rpc.example",
      "https://rpc.example/#secret",
      "invalid",
    ])
      expect(() => devnetRpc(rpc)).toThrow("HTTPS without userinfo");
  });
  test("all mutations need --execute before any wallet or RPC access", async () => {
    for (const args of [
      ["deploy"],
      ["airdrop"],
      ["upgrade", "--execute"],
      ["deploy", "--force"],
    ])
      await expect(main(args)).rejects.toThrow(
        "explicit deploy/airdrop --execute",
      );
  });
  test("plan is bound to wallet, cluster, program and config", () => {
    validatePlanIdentity(plan(), owner.publicKey);
    for (const change of [
      { version: 2 },
      { cluster: "mainnet" },
      { genesisHash: "bad" },
      { programId: PublicKey.default.toBase58() },
      { deployer: PublicKey.default.toBase58() },
      { config: PublicKey.default.toBase58() },
      { assets: [] },
    ])
      expect(() =>
        validatePlanIdentity(
          { ...plan(), ...change } as DeploymentPlan,
          owner.publicKey,
        ),
      ).toThrow("identity differs");
  });
});

describe("executable and authority read-back", () => {
  test("public uploads use validator-direct transport; RPC remains explicitly selectable", () => {
    expect(uploadTransport(DEVNET_RPC)).toEqual([
      "--use-tpu-client",
      "--use-quic",
    ]);
    expect(uploadTransport("http://127.0.0.1:8899")).toEqual(["--use-rpc"]);
    expect(uploadTransport(DEVNET_RPC, "rpc")).toEqual(["--use-rpc"]);
    expect(uploadTransport(DEVNET_RPC, "rpc-paced")).toEqual(["--use-rpc"]);
    expect(() => uploadTransport(DEVNET_RPC, "invalid")).toThrow(
      "tpu, rpc or rpc-paced",
    );
  });
  test("paced writes use canonical loader encoding, bounded offsets and packet size", () => {
    const buffer = Keypair.generate().publicKey,
      bytes = Buffer.alloc(UPLOAD_CHUNK_BYTES, 17);
    const ix = bufferWrite(buffer, owner.publicKey, 1234, bytes);
    expect(ix.programId.equals(LOADER)).toBe(true);
    expect(ix.data.readUInt32LE(0)).toBe(1);
    expect(ix.data.readUInt32LE(4)).toBe(1234);
    expect(ix.data.readBigUInt64LE(8)).toBe(900n);
    expect(ix.data.subarray(16).equals(bytes)).toBe(true);
    expect(ix.keys).toEqual([
      { pubkey: buffer, isSigner: false, isWritable: true },
      { pubkey: owner.publicKey, isSigner: true, isWritable: false },
    ]);
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: owner.publicKey,
        recentBlockhash: PublicKey.default.toBase58(),
        instructions: [ix],
      }).compileToV0Message(),
    );
    tx.sign([owner]);
    expect(tx.serialize().length).toBeLessThanOrEqual(1232);
    for (const offset of [-1, 0.1, 2 ** 32, NaN])
      expect(() => bufferWrite(buffer, owner.publicKey, offset, bytes)).toThrow(
        "range",
      );
    for (const length of [0, 901])
      expect(() =>
        bufferWrite(buffer, owner.publicKey, 0, Buffer.alloc(length)),
      ).toThrow("range");
  });
  test("paced resume compares all bytes including zero regions and final short chunk", () => {
    const artifact = Buffer.alloc(1801),
      uploaded = Buffer.alloc(1801);
    expect(missingChunks(artifact, uploaded)).toEqual([]);
    artifact[1] = 1;
    uploaded[901] = 1;
    artifact[1800] = 3;
    expect(missingChunks(artifact, uploaded)).toEqual([0, 900, 1800]);
    artifact.copy(uploaded, 0, 0, 900);
    expect(missingChunks(artifact, uploaded)).toEqual([900, 1800]);
    expect(() => missingChunks(artifact, Buffer.alloc(1800))).toThrow(
      "length differs",
    );
  });
  test("buffer rent credit requires exact loader, size, mutable state and authority", () => {
    const data = Buffer.alloc(137);
    data.writeUInt32LE(1);
    data[4] = 1;
    owner.publicKey.toBuffer().copy(data, 5);
    expect(verifyBuffer(null, 100, owner.publicKey)).toBe(0);
    expect(verifyBuffer(account(data), 100, owner.publicKey)).toBe(100);
    for (const bad of [
      { owner: SystemProgram.programId },
      { executable: true },
      { data: Buffer.alloc(37) },
      { lamports: -1 },
      { lamports: 0.5 },
      { lamports: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expect(() =>
        verifyBuffer(account(data, bad), 100, owner.publicKey),
      ).toThrow("buffer identity");
    expect(() =>
      verifyBuffer(account(data), 100, Keypair.generate().publicKey),
    ).toThrow("authority");
    data[4] = 0;
    expect(() => verifyBuffer(account(data), 100, owner.publicKey)).toThrow(
      "authority",
    );
    data[4] = 1;
    data[0] = 3;
    expect(() => verifyBuffer(account(data), 100, owner.publicKey)).toThrow(
      "identity",
    );
  });
  test("checks loader and canonical program record", () => {
    expect(readProgram(null)).toBeNull();
    expect(readProgram(programAccount())).toBeInstanceOf(PublicKey);
    for (const info of [
      account(Buffer.alloc(0)),
      { ...programAccount(), executable: false },
      { ...programAccount(), owner: SystemProgram.programId },
      account(Buffer.alloc(40), { executable: true }),
      account(Buffer.alloc(36), { executable: true }),
    ])
      expect(() => readProgram(info)).toThrow("canonical");
  });
  test("accepts byte-exact owned executable with zero capacity padding", () => {
    expect(
      verifyProgramData(programData(), Buffer.from("ELF"), owner.publicKey),
    ).toEqual({ slot: "12", bytes: 3, sha256: sha256("ELF") });
  });
  test("refuses wrong authority, immutable, truncated, wrong owner and modified bytes", () => {
    const immutable = programData();
    immutable.data[12] = 0;
    const invalidTag = programData();
    invalidTag.data[0] = 2;
    const padding = programData();
    padding.data[padding.data.length - 1] = 1;
    for (const info of [
      null,
      account(Buffer.alloc(44)),
      immutable,
      invalidTag,
      padding,
      { ...programData(), executable: true },
      { ...programData(), owner: SystemProgram.programId },
      programData(Buffer.from("BAD")),
    ])
      expect(() =>
        verifyProgramData(info, Buffer.from("ELF"), owner.publicKey),
      ).toThrow();
    expect(() =>
      verifyProgramData(programData(), Buffer.alloc(20), owner.publicKey),
    ).toThrow("differs");
    expect(() =>
      verifyProgramData(
        programData(),
        Buffer.from("ELF"),
        Keypair.generate().publicKey,
      ),
    ).toThrow("authority");
  });
  test("cannot substitute a different ProgramData address", async () => {
    const info = programAccount();
    Keypair.generate().publicKey.toBuffer().copy(info.data, 4);
    await expect(
      programStatus(
        { getAccountInfo: async () => info } as unknown as Connection,
        Buffer.from("ELF"),
        owner.publicKey,
      ),
    ).rejects.toThrow("PDA mismatch");
  });
});

describe("private durable deployment state", () => {
  test("generated mint keys are stable and private; no implicit missing-key replacement", async () => {
    const directory = await temp(),
      path = join(directory, "mint.json");
    await expect(keyFile(path, false)).rejects.toThrow("missing");
    const first = await keyFile(path, true);
    expect((await keyFile(path, true)).publicKey.equals(first.publicKey)).toBe(
      true,
    );
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    await unlink(path);
    await rmdir(directory);
  });
  test("private atomic records and no content leakage for malformed JSON", async () => {
    const directory = await temp(),
      path = join(directory, "state.json");
    expect(await readJson(path)).toBeNull();
    await writeJson(path, { n: 1 });
    await writeJson(path, { n: 2 });
    expect(await readJson<{ n: number }>(path)).toEqual({ n: 2 });
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    await writePrivate(path, "SECRET-{malformed");
    await expect(readJson(path)).rejects.toThrow("file contents suppressed");
    await unlink(path);
    await rmdir(directory);
  });
  test("symlink reads/writes and public directories are rejected", async () => {
    const directory = await temp(),
      target = join(directory, "target"),
      link = join(directory, "link");
    await writeJson(target, { safe: true });
    await symlink(target, link);
    await expect(readJson(link)).rejects.toThrow("safely read");
    await expect(writeJson(link, {})).rejects.toThrow("symlink");
    expect(await readJson<{ safe: boolean }>(target)).toEqual({ safe: true });
    await chmod(directory, 0o755);
    await expect(privateDirectory(directory)).rejects.toThrow("private");
    await chmod(directory, 0o700);
    await unlink(link);
    await unlink(target);
    await rmdir(directory);
    for (const path of [".local", ".", "/tmp/devnet"])
      await expect(deploymentDirectory(path)).rejects.toThrow("child");
  });
  test("exclusive lock refuses concurrent writers and cleans up after failures", async () => {
    const directory = await temp();
    await expect(
      locked(directory, async () => {
        await expect(locked(directory, async () => {})).rejects.toThrow(
          "locked",
        );
        throw new Error("test failure");
      }),
    ).rejects.toThrow("test failure");
    expect(await readJson(join(directory, "pipeline.lock"))).toBeNull();
    expect(await locked(directory, async () => 7)).toBe(7);
    await rmdir(directory);
  });
  test("temporary CLI signer is 0600 in 0700 directory and removed on success/failure", async () => {
    for (const fail of [false, true]) {
      let saved = "";
      const action = withTemporarySigner(owner, async (path) => {
        saved = path;
        expect((await lstat(path)).mode & 0o777).toBe(0o600);
        expect((await lstat(dirname(path))).mode & 0o777).toBe(0o700);
        expect(
          (await keyFile(path, false)).publicKey.equals(owner.publicKey),
        ).toBe(true);
        if (fail) throw new Error("test failure");
        return 7;
      });
      if (fail) await expect(action).rejects.toThrow("test failure");
      else expect(await action).toBe(7);
      expect(await readJson(saved)).toBeNull();
    }
  });
  test("exports public UI config without the wallet key or private backend RPC", async () => {
    const directory = await temp(),
      secret = bs58.encode(owner.secretKey),
      rpc = "https://rpc.example/?api-key=private";
    await exportEnvironment(directory, plan(), rpc, {
      DEVNET_DEPLOYER_PRIVATE_KEY: secret,
    });
    const ui = await readFile(join(directory, "ui.env"), "utf8"),
      backend = await readFile(join(directory, "backend.env"), "utf8");
    expect(ui).not.toContain("private");
    expect(ui).not.toContain(secret);
    expect(backend).not.toContain(secret);
    expect(backend).toContain(rpc);
    expect(ui).toContain(DEVNET_RPC);
    for (const name of ["ui.env", "backend.env"]) {
      expect((await lstat(join(directory, name))).mode & 0o777).toBe(0o600);
      await unlink(join(directory, name));
    }
    await expect(
      exportEnvironment(directory, plan(), rpc, {
        DEVNET_API_URL: "https://user:secret@api.example",
      }),
    ).rejects.toThrow("origin");
    await rmdir(directory);
  });
});

describe("fixture construction and transaction journal", () => {
  test("six exact mock allocations, one canonical native wrap, both token programs", async () => {
    const ctx = {
      deployer: owner,
      connection: { getMinimumBalanceForRentExemption: async () => 1000 },
    } as unknown as ChainContext;
    for (const spec of ASSETS) {
      const mint = spec.kind === "native" ? null : Keypair.generate();
      const built = await assetInstructions(ctx, spec, mint);
      expect(built.asset.initialRaw).toBe(
        rawAmount(spec.units, spec.decimals).toString(),
      );
      const program =
        spec.kind === "token2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
      expect(built.asset.program).toBe(program.toBase58());
      const ataInstruction = built.instructions.at(-2)!;
      if (mint) {
        const decoded = decodeMintToCheckedInstruction(
          built.instructions.at(-1)!,
          program,
        );
        expect(decoded.data.amount).toBe(BigInt(built.asset.initialRaw));
        expect(decoded.data.decimals).toBe(spec.decimals);
        expect(ataInstruction.data.length).toBe(0); // Never idempotent, so it cannot refill on retry.
      } else {
        expect(built.asset.mint).toBe(NATIVE_MINT.toBase58());
        expect(built.instructions.length).toBe(3);
        expect(built.instructions[0]!.data.length).toBe(0);
      }
      const tx = new VersionedTransaction(
        new TransactionMessage({
          payerKey: owner.publicKey,
          recentBlockhash: PublicKey.default.toBase58(),
          instructions: built.instructions,
        }).compileToV0Message(),
      );
      tx.sign(mint ? [owner, mint] : [owner]);
      expect(tx.serialize().length).toBeLessThanOrEqual(1232);
    }
    await expect(assetInstructions(ctx, ASSETS[0], null)).rejects.toThrow(
      "Missing mock mint",
    );
  });
  test("network guard and durable signed receipt precede any submission", async () => {
    const order: string[] = [];
    const ctx = {
      deployer: owner,
      assertNetwork: async () => {
        order.push("guard");
      },
      record: async (_: string, data: Record<string, unknown>) => {
        order.push(String(data.status));
      },
      connection: {
        getLatestBlockhash: async () => ({
          blockhash: PublicKey.default.toBase58(),
          lastValidBlockHeight: 10,
        }),
        sendRawTransaction: async (
          _bytes: Uint8Array,
          options: { preflightCommitment: string; skipPreflight: boolean },
        ) => {
          expect(options.preflightCommitment).toBe("confirmed");
          expect(options.skipPreflight).toBe(false);
          order.push("send");
          return "signature";
        },
        confirmTransaction: async () => ({
          value: { err: null },
          context: { slot: 2 },
        }),
      },
    } as unknown as ChainContext;
    await sendStep(ctx, "test", [
      SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    ]);
    expect(order).toEqual([
      "guard",
      "submitting",
      "send",
      "submitted",
      "finalized",
    ]);
    ctx.assertNetwork = async () => {
      throw new Error("wrong network");
    };
    order.length = 0;
    await expect(sendStep(ctx, "test", [])).rejects.toThrow("wrong network");
    expect(order).toEqual([]);
  });
  for (const scenario of [
    "finalized",
    "pending",
    "unknown-live",
    "expired-mint",
    "expired-SOL",
    "failed",
  ] as const) {
    test("journal recovery: " + scenario, async () => {
      const directory = await temp(),
        prepared = plan(),
        step = scenario === "expired-SOL" ? "asset:SOL" : "asset:USDC";
      await writeJson(join(directory, "journal.json"), {
        planSha256: sha256(JSON.stringify(prepared)),
        events: [
          {
            step,
            status: "submitted",
            signature: "s",
            lastValidBlockHeight: 10,
            at: "now",
          },
        ],
      });
      const connection = {
        getSignatureStatuses: async () => ({
          value: [
            scenario === "finalized"
              ? { confirmationStatus: "finalized", slot: 2, err: null }
              : scenario === "pending"
                ? { confirmationStatus: "confirmed", err: null }
                : scenario === "failed"
                  ? { err: "failed" }
                  : null,
          ],
        }),
        getBlockHeight: async () => (scenario === "unknown-live" ? 9 : 11),
      } as unknown as Connection;
      const action = journalContext(
        connection,
        owner,
        directory,
        prepared,
        async () => {},
      );
      if (["pending", "unknown-live"].includes(scenario))
        await expect(action).rejects.toThrow("pending");
      else if (scenario === "expired-SOL")
        await expect(action).rejects.toThrow("unknown history");
      else
        expect((await action).completed.has(step)).toBe(
          scenario === "finalized",
        );
      await unlink(join(directory, "journal.json"));
      await rmdir(directory);
    });
  }
  test("journal cannot be reused for a different prepared identity", async () => {
    const directory = await temp();
    await writeJson(join(directory, "journal.json"), {
      planSha256: "wrong",
      events: [],
    });
    await expect(
      journalContext(
        {} as Connection,
        owner,
        directory,
        plan(),
        async () => {},
      ),
    ).rejects.toThrow("different deployment");
    await unlink(join(directory, "journal.json"));
    await rmdir(directory);
  });
  test("funding includes the deployment buffer, accounts, native wrap and fee reserve", async () => {
    const connection = {
      getAccountInfo: async () => null,
      getMinimumBalanceForRentExemption: async () => 1,
      getBalance: async () => 200_000_015,
    } as unknown as Connection;
    const result = await fundingPlan(connection, plan());
    expect(result.conservativeRequiredLamports).toBe("200000016");
    expect(result.sufficient).toBe(false);
  });
  test("resuming reuses owned buffer funding without consuming Program-account rent or fee reserves", async () => {
    const prepared = plan(),
      buffer = Keypair.generate().publicKey,
      data = Buffer.alloc(prepared.artifactBytes + 37);
    data.writeUInt32LE(1);
    data[4] = 1;
    owner.publicKey.toBuffer().copy(data, 5);
    const connection = {
      getAccountInfo: async (key: PublicKey) =>
        key.equals(buffer) ? account(data, { lamports: 1_000_000_000 }) : null,
      getMinimumBalanceForRentExemption: async (space: number) =>
        space === prepared.artifactBytes + 45
          ? 1_000_000_008
          : space === prepared.artifactBytes + 37
            ? 1_000_000_000
            : 1,
      getBalance: async () => 200_000_023,
    } as unknown as Connection;
    const initial = await fundingPlan(connection, prepared);
    expect(initial.conservativeRequiredLamports).toBe("1200000023");
    expect(initial.sufficient).toBe(false);
    const resumed = await fundingPlan(connection, prepared, buffer);
    expect(resumed.prepaidBufferLamports).toBe("1000000000");
    expect(resumed.conservativeRequiredLamports).toBe("200000023");
    expect(resumed.sufficient).toBe(true);
    connection.getAccountInfo = async (key) =>
      key.equals(buffer) ? account(data, { lamports: 9_000_000_000 }) : null;
    expect(
      (await fundingPlan(connection, prepared, buffer))
        .conservativeRequiredLamports,
    ).toBe("200000015");
    connection.getAccountInfo = async (key) =>
      key.equals(buffer)
        ? account(data, { owner: SystemProgram.programId })
        : null;
    await expect(fundingPlan(connection, prepared, buffer)).rejects.toThrow(
      "buffer identity",
    );
  });
});
