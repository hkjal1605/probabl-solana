import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { ASSETS, PROGRAM_ID, type DeploymentPlan } from "../devnet-policy.ts";
import { ISSUERS } from "../mock-issuers.ts";
import { writeJson, readJson } from "../devnet-store.ts";
import { decodeSupportedMint } from "@conditional-stocks/solana-client";
import { pacedUpload } from "../devnet-upload.ts";
import {
  prepare,
  loadPlan,
  programStatus,
  deployProgram,
  journalContext,
} from "../devnet.ts";
import {
  initializeAssets,
  initializeConfig,
  verifyAsset,
  verifyConfiguration,
  sendStep,
  type ChainContext,
} from "../devnet-chain.ts";

// Opt-in only. This deploys a real upgradeable SBF executable on a FRESH local
// validator. The public CLI has no flag/env override for its Devnet genesis pin.
const rpc = process.env.DEVNET_PIPELINE_TEST_RPC;
const enabled = !!rpc;
if (
  enabled &&
  !["127.0.0.1", "localhost", "[::1]"].includes(new URL(rpc!).hostname)
)
  throw new Error("Pipeline rehearsal requires a localhost RPC");

describe.skipIf(!enabled)("fresh-validator deployment rehearsal", () => {
  let connection: Connection,
    deployer: Keypair,
    directory: string,
    plan: DeploymentPlan,
    artifact: Buffer;
  let signers: Map<string, Keypair>, ctx: ChainContext;
  const programPath = "target/deploy/conditional_stocks-keypair.json";
  beforeAll(async () => {
    connection = new Connection(rpc!, "finalized");
    if (await connection.getAccountInfo(PROGRAM_ID))
      throw new Error("Use a fresh validator without a preloaded program");
    const genesis = await connection.getGenesisHash();
    deployer = Keypair.generate();
    directory = await mkdtemp(resolve(".local/devnet-pipeline-test-"));
    await writeJson(join(directory, "local-only-deployer.json"), [
      ...deployer.secretKey,
    ]);
    const latest = await connection.getLatestBlockhash("confirmed");
    const signature = await connection.requestAirdrop(
      deployer.publicKey,
      50_000_000_000,
    );
    expect(
      (
        await connection.confirmTransaction(
          { signature, ...latest },
          "finalized",
        )
      ).value.err,
    ).toBeNull();
    plan = await prepare(directory, deployer.publicKey, programPath);
    ({ artifact, signers } = await loadPlan(directory, deployer.publicKey));
    ({ ctx } = await journalContext(
      connection,
      deployer,
      directory,
      plan,
      async () => {
        if ((await connection.getGenesisHash()) !== genesis)
          throw new Error("Local validator genesis changed");
      },
    ));
    console.info("Local-only pipeline fixture: " + directory);
  }, 90_000);

  test("prepare persists identical addresses and rejects another deployer", async () => {
    expect(await prepare(directory, deployer.publicKey, programPath)).toEqual(
      plan,
    );
    await expect(
      prepare(directory, Keypair.generate().publicKey, programPath),
    ).rejects.toThrow("identity differs");
    expect(signers.size).toBe(ASSETS.filter((a) => a.kind !== "native").length);
  });
  test("paced buffer writes are byte-exact, preserve authority and resume without duplicate fees", async () => {
    const buffer = Keypair.generate(),
      bytes = Buffer.alloc(2701, 17);
    await writeJson(join(directory, "local-only-paced-buffer.json"), [
      ...buffer.secretKey,
    ]);
    bytes.fill(0, 900, 1800);
    await pacedUpload(ctx, buffer, bytes);
    expect(
      (await connection.getAccountInfo(buffer.publicKey, "finalized"))!.data
        .subarray(37)
        .equals(bytes),
    ).toBe(true);
    const before = await connection.getBalance(deployer.publicKey, "finalized");
    await pacedUpload(ctx, buffer, bytes);
    expect(await connection.getBalance(deployer.publicKey, "finalized")).toBe(
      before,
    );
  }, 90_000);
  test("real CLI deploy verifies the exact executable, loader and upgrade authority", async () => {
    await deployProgram(ctx, directory, programPath, artifact);
    expect(
      (await programStatus(connection, artifact, deployer.publicKey))?.sha256,
    ).toBe(plan.artifactSha256);
    await expect(
      programStatus(connection, artifact, Keypair.generate().publicKey),
    ).rejects.toThrow("authority");
    const changed = Buffer.from(artifact);
    changed[changed.length - 1] = changed.at(-1)! ^ 1;
    await expect(
      programStatus(connection, changed, deployer.publicKey),
    ).rejects.toThrow("differs");
  }, 300_000);
  test("atomically creates every allocation, issuer replicas included, and initializes correct protocol roles", async () => {
    await initializeAssets(ctx, plan, signers, new Set());
    await initializeConfig(ctx, plan);
    await verifyConfiguration(ctx, plan);
    for (const asset of plan.assets) {
      const verified = await verifyAsset(ctx, asset);
      expect(verified.currentRawBalance).toBe(asset.initialRaw);
      expect(verified.tokenAccountExists).toBe(true);
      if (asset.symbol !== "SOL")
        expect(verified.currentSupply).toBe(asset.initialRaw);
    }
  }, 480_000); // One finalized step per allocation (12 assets).
  test("reruns and uncertain-receipt recovery do not deploy or mint again", async () => {
    const before = await connection.getBalance(deployer.publicKey, "finalized");
    await deployProgram(ctx, directory, programPath, artifact);
    await initializeAssets(ctx, plan, signers, new Set()); // Fully matching atomic state can be adopted.
    await initializeConfig(ctx, plan);
    const recovered = await journalContext(
      connection,
      deployer,
      directory,
      plan,
      ctx.assertNetwork,
    );
    expect(
      [...recovered.completed].filter((s) => s.startsWith("asset:")).length,
    ).toBe(ASSETS.length);
    await initializeAssets(recovered.ctx, plan, signers, recovered.completed);
    expect(await connection.getBalance(deployer.publicKey, "finalized")).toBe(
      before,
    );
  }, 90_000);
  test("issuer-replica transfers debit/credit exactly; later reruns do not refill spent allocations", async () => {
    const asset = plan.assets.find((a) => a.symbol === "NVDAon")!,
      mint = new PublicKey(asset.mint);
    // Real Token-2022 extension state of the replica: exact issuer admission set.
    const decoded = decodeSupportedMint(mint, await connection.getAccountInfo(mint, "finalized"));
    expect(decoded.issuer.controls).toBe(ISSUERS.ondo.admitted);
    expect(decoded.issuer.paused).toBe(false);
    expect(decoded.decimals).toBe(9);
    const receiver = Keypair.generate().publicKey,
      ata = getAssociatedTokenAddressSync(
        mint,
        receiver,
        false,
        TOKEN_2022_PROGRAM_ID,
      );
    await sendStep(ctx, "test:transfer", [
      createAssociatedTokenAccountInstruction(
        deployer.publicKey,
        ata,
        receiver,
        mint,
        TOKEN_2022_PROGRAM_ID,
      ),
      createTransferCheckedInstruction(
        new PublicKey(asset.ata),
        mint,
        ata,
        deployer.publicKey,
        100_000_000n,
        9,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    ]);
    expect(
      (await getAccount(connection, ata, "finalized", TOKEN_2022_PROGRAM_ID))
        .amount,
    ).toBe(100_000_000n);
    const replay = await journalContext(
      connection,
      deployer,
      directory,
      plan,
      ctx.assertNetwork,
    );
    await initializeAssets(replay.ctx, plan, signers, replay.completed);
    const verified = await verifyAsset(ctx, asset);
    expect(verified.currentRawBalance).toBe(
      (BigInt(asset.initialRaw) - 100_000_000n).toString(),
    );
    expect(verified.currentSupply).toBe(asset.initialRaw);
    await expect(
      initializeAssets(ctx, plan, signers, new Set()),
    ).rejects.toThrow("cannot be safely adopted");
  }, 90_000);
  test("unwrapping SOL then rerunning never recreates or re-funds its closed account", async () => {
    const asset = plan.assets.find((a) => a.symbol === "SOL")!;
    await sendStep(ctx, "test:unwrap", [
      createCloseAccountInstruction(
        new PublicKey(asset.ata),
        deployer.publicKey,
        deployer.publicKey,
        [],
        TOKEN_PROGRAM_ID,
      ),
    ]);
    const before = await connection.getBalance(deployer.publicKey, "finalized");
    const replay = await journalContext(
      connection,
      deployer,
      directory,
      plan,
      ctx.assertNetwork,
    );
    await initializeAssets(replay.ctx, plan, signers, replay.completed);
    expect((await verifyAsset(ctx, asset)).currentRawBalance).toBe("0");
    expect((await verifyAsset(ctx, asset)).tokenAccountExists).toBe(false);
    expect(await connection.getBalance(deployer.publicKey, "finalized")).toBe(
      before,
    );
    await writeJson(join(directory, "rehearsal.json"), {
      localOnly: true,
      rpc,
      programId: plan.programId,
      artifactSha256: plan.artifactSha256,
      deployer: plan.deployer,
      allocationsVerified: ASSETS.length,
      passed: true,
    });
    const journal = await readFile(join(directory, "journal.json"), "utf8");
    expect(journal).not.toContain(JSON.stringify([...deployer.secretKey]));
    expect(await readJson(join(directory, "rehearsal.json"))).not.toBeNull();
  }, 90_000);
});
