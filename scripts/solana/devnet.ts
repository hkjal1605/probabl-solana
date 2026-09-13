/** Devnet staging only. No default wallet, automatic upgrades, EC2 deployment,
 * unlimited faucets, or live markets. All mutation requires --execute. */
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { pacedUpload } from "./devnet-upload.ts";
import { configAddress } from "@conditional-stocks/solana-client";
import {
  ASSETS,
  DEVNET_GENESIS,
  DEVNET_RPC,
  PROGRAM_ID,
  NATIVE_MINT,
  LOADER,
  assertDevnet,
  devnetRpc,
  parseDeployer,
  readProgram,
  verifyBuffer,
  uploadTransport,
  verifyProgramData,
  sha256,
  validatePlanIdentity,
  type DeploymentPlan,
} from "./devnet-policy.ts";
import {
  deploymentDirectory,
  keyFile,
  privateDirectory,
  locked,
  readJson,
  writeJson,
  writePrivate,
  withTemporarySigner,
} from "./devnet-store.ts";
import {
  assetPlan,
  initializeAssets,
  initializeConfig,
  verifyAsset,
  verifyConfiguration,
  type ChainContext,
} from "./devnet-chain.ts";

const ARTIFACT = "target/deploy/conditional_stocks.so";
type Event = Record<string, unknown> & { step: string; at: string };
interface Journal {
  planSha256: string;
  events: Event[];
}
export async function artifactIdentity() {
  const artifact = await readFile(ARTIFACT),
    sdkIdl = JSON.parse(
      await readFile("packages/solana-client/src/idl.json", "utf8"),
    );
  const generated = JSON.parse(
    await readFile("target/idl/conditional_stocks.json", "utf8"),
  );
  if (
    artifact.length < 64 ||
    !artifact.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) ||
    generated.address !== PROGRAM_ID.toBase58() ||
    JSON.stringify(sdkIdl) !== JSON.stringify(generated)
  )
    throw new Error("Build artifact/IDL mismatch; run devnet:build");
  const rust = await readFile("programs/conditional-stocks/src/lib.rs", "utf8");
  if (!rust.includes('declare_id!("' + PROGRAM_ID.toBase58() + '")'))
    throw new Error("Rust program ID differs from SDK");
  const paths = [
    "Cargo.lock",
    "bun.lock",
    "Anchor.toml",
    "Cargo.toml",
    "programs/conditional-stocks/Cargo.toml",
    "crates/protocol-core/Cargo.toml",
  ];
  for (const glob of [
    "programs/conditional-stocks/src/*.rs",
    "crates/protocol-core/src/*.rs",
  ])
    for (const path of new Bun.Glob(glob).scanSync(".")) paths.push(path);
  const sourceSha256: Record<string, string> = {};
  for (const path of paths.sort())
    sourceSha256[path] = sha256(await readFile(path));
  return {
    artifact,
    identity: {
      artifactSha256: sha256(artifact),
      artifactBytes: artifact.length,
      idlSha256: sha256(JSON.stringify(sdkIdl)),
      sourceSha256,
    },
  };
}
export async function prepare(
  directory: string,
  owner: PublicKey,
  programPath: string,
) {
  const { identity } = await artifactIdentity();
  if (!(await keyFile(programPath, false)).publicKey.equals(PROGRAM_ID))
    throw new Error("Program signer does not match compiled program ID");
  const existing = await readJson<DeploymentPlan>(join(directory, "plan.json"));
  if (existing) {
    validatePlanIdentity(existing, owner);
    if (
      JSON.stringify({
        artifactSha256: existing.artifactSha256,
        artifactBytes: existing.artifactBytes,
        idlSha256: existing.idlSha256,
        sourceSha256: existing.sourceSha256,
      }) !== JSON.stringify(identity)
    )
      throw new Error(
        "Prepared source/artifact changed. Archive the old deployment record and explicitly prepare a new directory; no automatic upgrades",
      );
  }
  await privateDirectory(join(directory, "mints"));
  const assets = [];
  for (const spec of ASSETS) {
    const mint =
      spec.kind === "native"
        ? NATIVE_MINT
        : (
            await keyFile(
              join(directory, "mints", spec.symbol + ".json"),
              !existing,
            )
          ).publicKey;
    assets.push(assetPlan(spec, mint, owner));
  }
  const plan: DeploymentPlan = {
    version: 1,
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    programId: PROGRAM_ID.toBase58(),
    deployer: owner.toBase58(),
    config: configAddress(owner).toBase58(),
    ...identity,
    assets,
  };
  if (existing && JSON.stringify(existing) !== JSON.stringify(plan))
    throw new Error("Prepared mint addresses or fixture parameters changed");
  await keyFile(join(directory, "buffer.json"), !existing);
  // Publish the plan only after every stable signer is durable. A crash during
  // preparation can reuse those signers without an incomplete committed plan.
  if (!existing) await writeJson(join(directory, "plan.json"), plan);
  return plan;
}
export async function loadPlan(directory: string, owner: PublicKey) {
  const plan = await readJson<DeploymentPlan>(join(directory, "plan.json"));
  if (!plan) throw new Error("Run devnet:prepare first");
  validatePlanIdentity(plan, owner);
  const { artifact, identity } = await artifactIdentity();
  if (
    plan.artifactSha256 !== identity.artifactSha256 ||
    plan.idlSha256 !== identity.idlSha256 ||
    plan.artifactBytes !== artifact.length ||
    JSON.stringify(plan.sourceSha256) !== JSON.stringify(identity.sourceSha256)
  )
    throw new Error(
      "Prepared artifact, IDL or source changed; refusing deployment",
    );
  const signers = new Map<string, Keypair>();
  for (const spec of ASSETS) {
    const signer =
      spec.kind === "native"
        ? null
        : await keyFile(join(directory, "mints", spec.symbol + ".json"), false);
    if (signer) signers.set(spec.symbol, signer);
    if (
      JSON.stringify(
        assetPlan(spec, signer?.publicKey ?? NATIVE_MINT, owner),
      ) !== JSON.stringify(plan.assets.find((a) => a.symbol === spec.symbol))
    )
      throw new Error("Prepared mint identity or policy differs");
  }
  return { plan, artifact, signers };
}
export async function programStatus(
  connection: Connection,
  artifact: Buffer,
  owner: PublicKey,
) {
  const address = readProgram(
    await connection.getAccountInfo(PROGRAM_ID, "finalized"),
  );
  if (!address) return null;
  if (
    !address.equals(
      PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], LOADER)[0],
    )
  )
    throw new Error("ProgramData PDA mismatch");
  return {
    address: address.toBase58(),
    ...verifyProgramData(
      await connection.getAccountInfo(address, "finalized"),
      artifact,
      owner,
    ),
  };
}
export async function fundingPlan(
  connection: Connection,
  plan: DeploymentPlan,
  bufferAddress?: PublicKey,
) {
  const programExists = !!(await connection.getAccountInfo(
    PROGRAM_ID,
    "finalized",
  ));
  // Loader-v3 drains the authorized buffer to the payer BEFORE funding
  // ProgramData. Budget the larger allocation, not both simultaneously.
  // The Program account is created first, so always retain its separate rent.
  let programRent = 0,
    prepaidBufferLamports = 0;
  if (!programExists) {
    const allocationRent = Math.max(
      await connection.getMinimumBalanceForRentExemption(
        plan.artifactBytes + 45,
      ),
      await connection.getMinimumBalanceForRentExemption(
        plan.artifactBytes + 37,
      ),
    );
    if (bufferAddress)
      prepaidBufferLamports = verifyBuffer(
        await connection.getAccountInfo(bufferAddress, "finalized"),
        plan.artifactBytes,
        new PublicKey(plan.deployer),
      );
    programRent =
      Math.max(0, allocationRent - prepaidBufferLamports) +
      (await connection.getMinimumBalanceForRentExemption(36));
  }
  const fixtureRent =
    (await connection.getMinimumBalanceForRentExemption(1024)) * 6 +
    (await connection.getMinimumBalanceForRentExemption(256)) * 8;
  const wrap = BigInt(plan.assets.find((a) => a.symbol === "SOL")!.initialRaw);
  const required = BigInt(programRent + fixtureRent) + wrap + 100_000_000n;
  const balance = BigInt(
    await connection.getBalance(new PublicKey(plan.deployer), "finalized"),
  );
  return {
    currentLamports: balance.toString(),
    conservativeRequiredLamports: required.toString(),
    prepaidBufferLamports: prepaidBufferLamports.toString(),
    sufficient: balance >= required,
    note: "Peak program allocation reuses verified buffer rent; includes separate program-account rent, fixtures, 0.1 wrapped SOL and 0.1 SOL fee reserve. No automatic faucet or mainnet funds.",
  };
}
export async function journalContext(
  connection: Connection,
  deployer: Keypair,
  directory: string,
  plan: DeploymentPlan,
  guard: () => Promise<void>,
) {
  const path = join(directory, "journal.json"),
    planSha256 = sha256(JSON.stringify(plan));
  const journal = (await readJson<Journal>(path)) ?? { planSha256, events: [] };
  if (journal.planSha256 !== planSha256 || !Array.isArray(journal.events))
    throw new Error("Journal belongs to a different deployment plan");
  const ctx: ChainContext = {
    connection,
    deployer,
    assertNetwork: guard,
    record: async (step, value) => {
      journal.events.push({ ...value, step, at: new Date().toISOString() });
      await writeJson(path, journal);
    },
  };
  const completed = new Set<string>();
  for (const step of new Set(journal.events.map((e) => e.step))) {
    const events = journal.events.filter((e) => e.step === step),
      latest = events.at(-1)!;
    if (["finalized", "recovered"].includes(String(latest.status))) {
      completed.add(step);
      continue;
    }
    if (!step.startsWith("asset:") && step !== "config") continue;
    const sent = [...events]
      .reverse()
      .find(
        (e) =>
          typeof e.signature === "string" ||
          typeof e.signedTransaction === "string",
      );
    if (!sent) continue;
    const signature =
      typeof sent.signature === "string"
        ? sent.signature
        : bs58.encode(
            // Decode only locally generated transaction records; no network submission here.
            (await import("@solana/web3.js")).VersionedTransaction.deserialize(
              Buffer.from(String(sent.signedTransaction), "base64"),
            ).signatures[0]!,
          );
    const status = (
      await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      })
    ).value[0];
    if (status?.err) continue; // Atomic rollback: a new guarded creation is safe.
    if (status?.confirmationStatus === "finalized") {
      await ctx.record(step, {
        status: "recovered",
        signature,
        slot: status.slot,
      });
      completed.add(step);
    } else if (
      status ||
      (await connection.getBlockHeight("finalized")) <=
        Number(sent.lastValidBlockHeight)
    ) {
      throw new Error(
        "Prior transaction is still pending; wait and rerun without deleting journal.json",
      );
    } else if (step === "asset:SOL") {
      throw new Error(
        "Prior SOL wrap has unknown history; verify its receipt manually before recovery. Never delete the journal or automatically rewrap",
      );
    }
  }
  return { ctx, completed, journal };
}
export async function deployProgram(
  ctx: ChainContext,
  directory: string,
  programPath: string,
  artifact: Buffer,
) {
  await ctx.assertNetwork();
  if (await programStatus(ctx.connection, artifact, ctx.deployer.publicKey))
    return;
  const program = await keyFile(programPath, false),
    buffer = await keyFile(join(directory, "buffer.json"), false);
  if (!program.publicKey.equals(PROGRAM_ID))
    throw new Error("Wrong program signer");
  const info = await ctx.connection.getAccountInfo(
    buffer.publicKey,
    "finalized",
  );
  verifyBuffer(info, artifact.length, ctx.deployer.publicKey);
  const transport = uploadTransport(
    ctx.connection.rpcEndpoint,
    process.env.DEVNET_UPLOAD_TRANSPORT,
  );
  if (process.env.DEVNET_UPLOAD_TRANSPORT === "rpc-paced")
    await pacedUpload(ctx, buffer, artifact);
  await ctx.record("program", {
    status: "submitting",
    program: PROGRAM_ID.toBase58(),
    buffer: buffer.publicKey.toBase58(),
    artifactSha256: sha256(artifact),
    transport: transport[0],
  });
  await withTemporarySigner(ctx.deployer, async (signerPath) => {
    await ctx.assertNetwork();
    const child = Bun.spawn(
      [
        "solana",
        "program",
        "deploy",
        resolve(ARTIFACT),
        "--url",
        ctx.connection.rpcEndpoint,
        "--keypair",
        signerPath,
        "--fee-payer",
        signerPath,
        "--upgrade-authority",
        signerPath,
        "--program-id",
        resolve(programPath),
        "--buffer",
        join(directory, "buffer.json"),
        "--max-len",
        String(artifact.length),
        "--commitment",
        "confirmed",
        "--with-compute-unit-price",
        "0",
        "--max-sign-attempts",
        "3",
        ...transport,
        "--output",
        "json",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([k]) => k !== "DEVNET_DEPLOYER_PRIVATE_KEY",
          ),
        ),
      },
    );
    // Drain output but never echo CLI errors/seed material or RPC credentials.
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) {
      const category = /429|too many requests|rate.limit/i.test(stderr)
        ? "RPC rate limit"
        : /insufficient|balance.*required/i.test(stderr)
          ? "insufficient funding"
          : "CLI upload or confirmation failure";
      await ctx.record("program", {
        status: "failed",
        exitCode: code,
        category,
      });
      throw new Error(
        "Solana deploy failed (exit " +
          code +
          ", " +
          category +
          "). Same buffer is retained for retry; inspect funding/RPC, not a new program ID",
      );
    }
    // Store only a validated public receipt, never raw CLI output.
    let receipt: { programId?: string; signature?: string } | undefined;
    try {
      receipt = JSON.parse(stdout);
    } catch {
      /* Finalized read-back remains authoritative. */
    }
    if (
      receipt?.programId === PROGRAM_ID.toBase58() &&
      typeof receipt.signature === "string" &&
      /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(receipt.signature)
    )
      await ctx.record("program", {
        status: "confirmed",
        signature: receipt.signature,
      });
  });
  // CLI confirms at confirmed; wait for read-back at finalized without guessing.
  for (let attempt = 0; attempt < 60; attempt++) {
    await ctx.assertNetwork();
    const status = await programStatus(
      ctx.connection,
      artifact,
      ctx.deployer.publicKey,
    );
    if (status) {
      await ctx.record("program", { status: "finalized", ...status });
      return;
    }
    await Bun.sleep(1000);
  }
  throw new Error(
    "Program not finalized yet; rerun to verify before any token/config initialization",
  );
}
function serviceOrigin(value: string) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.hash ||
    url.search
  )
    throw new Error("Service URL must be an HTTP(S) origin");
  return url.origin;
}
export async function exportEnvironment(
  directory: string,
  plan: DeploymentPlan,
  rpc: string,
  env: Record<string, string | undefined>,
) {
  const browserRpc = devnetRpc(env.DEVNET_BROWSER_RPC_URL ?? DEVNET_RPC);
  const api = serviceOrigin(env.DEVNET_API_URL ?? "http://127.0.0.1:3000"),
    indexer = serviceOrigin(env.DEVNET_INDEXER_URL ?? "http://127.0.0.1:42069");
  const origins = (
    env.DEVNET_UI_ORIGINS ?? "http://localhost:3001,http://localhost:3002"
  )
    .split(",")
    .map(serviceOrigin)
    .join(",");
  const lines = (values: Record<string, string>) =>
    Object.entries(values)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join("\n") + "\n";
  await writePrivate(
    join(directory, "backend.env"),
    lines({
      SOLANA_RPC_URL: rpc,
      SOLANA_PROGRAM_ID: plan.programId,
      SOLANA_CONFIG: plan.config,
      SOLANA_GENESIS_HASH: plan.genesisHash,
      API_HOST: "127.0.0.1",
      API_PORT: "3000",
      INDEXER_HOST: "127.0.0.1",
      INDEXER_PORT: "42069",
      API_AUTH_ORIGINS: origins,
      INDEXER_URL: indexer,
      API_URL: api,
      MARKET_ADMIN: plan.deployer,
    }),
  );
  await writePrivate(
    join(directory, "ui.env"),
    lines({
      API_URL: api,
      INDEXER_URL: indexer,
      NEXT_PUBLIC_API_URL: api,
      NEXT_PUBLIC_SOLANA_RPC_URL: browserRpc,
      NEXT_PUBLIC_SOLANA_PROGRAM_ID: plan.programId,
      NEXT_PUBLIC_SOLANA_CONFIG: plan.config,
      NEXT_PUBLIC_SOLANA_GENESIS_HASH: plan.genesisHash,
      NEXT_PUBLIC_SOLANA_CLUSTER_NAME: "Solana Devnet (mock assets)",
      // The pipeline verifies every staging role matches this deployer before export.
      // These are display hints only; the admin UI verifies live on-chain roles.
      NEXT_PUBLIC_SOLANA_MARKET_ADMIN: plan.deployer,
      NEXT_PUBLIC_SOLANA_RESOLUTION_ADMIN: plan.deployer,
      NEXT_PUBLIC_APP_URL: "http://localhost:3001",
    }),
  );
}
export async function main(args = process.argv.slice(2)) {
  const [command, ...flags] = args;
  if (!command || command === "--help") {
    console.info(
      "devnet.ts prepare | plan | verify | airdrop --execute | deploy --execute\nRead DEVNET_DEPLOYER_PRIVATE_KEY from ignored .env.devnet. No default wallet or automatic upgrades.",
    );
    return;
  }
  if (
    !["prepare", "plan", "verify", "airdrop", "deploy"].includes(command) ||
    flags.some((f) => f !== "--execute") ||
    (["airdrop", "deploy"].includes(command) && !flags.includes("--execute"))
  )
    throw new Error(
      "Network mutation requires an explicit deploy/airdrop --execute command",
    );
  const deployer = parseDeployer(process.env.DEVNET_DEPLOYER_PRIVATE_KEY),
    rpc = devnetRpc(process.env.DEVNET_RPC_URL);
  const connection = new Connection(rpc, {
    commitment: "finalized",
    disableRetryOnRateLimit: true,
  });
  await assertDevnet(connection);
  const directory = await deploymentDirectory(process.env.DEVNET_OUTPUT_DIR);
  const programPath =
    process.env.DEVNET_PROGRAM_KEYPAIR ??
    "target/deploy/conditional_stocks-keypair.json";
  await locked(directory, async () => {
    if (command === "prepare") {
      const plan = await prepare(directory, deployer.publicKey, programPath);
      console.info(
        JSON.stringify(
          {
            prepared: true,
            directory,
            deployer: plan.deployer,
            programId: plan.programId,
            artifactSha256: plan.artifactSha256,
            assets: plan.assets,
          },
          null,
          2,
        ),
      );
      return;
    }
    if (command === "airdrop") {
      // One bounded request, never rotate wallets or retry a faucet limit.
      await assertDevnet(connection);
      const signature = await connection.requestAirdrop(
        deployer.publicKey,
        2_000_000_000,
      );
      console.info(
        JSON.stringify({
          airdropRequested: signature,
          deployer: deployer.publicKey.toBase58(),
          requestedSOL: 2,
          note: "Check finalized balance with devnet:plan; faucet success is not guaranteed",
        }),
      );
      return;
    }
    const { plan, artifact, signers } = await loadPlan(
      directory,
      deployer.publicKey,
    );
    if (command === "plan") {
      const existing = await programStatus(
        connection,
        artifact,
        deployer.publicKey,
      );
      console.info(
        JSON.stringify(
          {
            ...plan,
            programAlreadyVerified: !!existing,
            funding: await fundingPlan(
              connection,
              plan,
              (await keyFile(join(directory, "buffer.json"), false)).publicKey,
            ),
          },
          null,
          2,
        ),
      );
      return;
    }
    const { ctx, completed } = await journalContext(
      connection,
      deployer,
      directory,
      plan,
      () => assertDevnet(connection),
    );
    if (command === "deploy") {
      // Check program identity before any allocation, even if funds are short.
      await programStatus(connection, artifact, deployer.publicKey);
      const funding = await fundingPlan(
        connection,
        plan,
        (await keyFile(join(directory, "buffer.json"), false)).publicKey,
      );
      if (!funding.sufficient)
        throw new Error(
          "Insufficient Devnet SOL. Run devnet:plan for the conservative funding budget; no assets or program changes submitted",
        );
      await deployProgram(ctx, directory, programPath, artifact);
      await initializeAssets(ctx, plan, signers, completed);
      await initializeConfig(ctx, plan);
    }
    await ctx.assertNetwork();
    const program = await programStatus(
      connection,
      artifact,
      deployer.publicKey,
    );
    if (!program) throw new Error("Program is not deployed");
    await verifyConfiguration(ctx, plan);
    const assets = [];
    for (const asset of plan.assets) assets.push(await verifyAsset(ctx, asset));
    // A prior CLI success can outlive a rate-limited read-back. Record final
    // verification on both deploy and verify paths without resubmitting it.
    await ctx.record("program", { status: "finalized", ...program });
    // Public record deliberately excludes all signer bytes and RPC credentials.
    await writeJson(join(directory, "deployment.json"), {
      ...plan,
      productionApproved: false,
      mockAssets: true,
      verifiedAt: new Date().toISOString(),
      program,
      upgradeAuthority: plan.deployer,
      mintAuthority: plan.deployer,
      roles: "All three operational roles use deployer for Devnet only",
      assets,
    });
    await exportEnvironment(directory, plan, rpc, process.env);
    console.info(
      JSON.stringify(
        {
          verified: true,
          cluster: "devnet",
          programId: plan.programId,
          deployer: plan.deployer,
          config: plan.config,
          assets,
          record: join(directory, "deployment.json"),
          note: "No markets or EC2 services were created. No real stock rights.",
        },
        null,
        2,
      ),
    );
  });
}
if (import.meta.main)
  main().catch((error) => {
    // Untrusted RPC errors can contain endpoint credentials. Show only our
    // explicit messages; redact the env key and endpoint if nested libraries echo them.
    const secret = process.env.DEVNET_DEPLOYER_PRIVATE_KEY,
      rpc = process.env.DEVNET_RPC_URL;
    let message =
      error instanceof Error ? error.message : "Devnet pipeline failed";
    for (const value of [secret, rpc])
      if (value) message = message.replaceAll(value, "[REDACTED]");
    message = message.replace(/https?:\/\/[^\s"']+/g, "[RPC endpoint]");
    console.error(message);
    process.exitCode = 1;
  });
