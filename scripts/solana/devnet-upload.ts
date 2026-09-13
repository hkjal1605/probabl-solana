/** Bounded, paced loader-v3 writes for rate-limited Devnet RPCs. This only
 * prepares a buffer; the Solana CLI still verifies and deploys the executable. */
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { LOADER, verifyBuffer } from "./devnet-policy.ts";
import { sendStep, type ChainContext } from "./devnet-chain.ts";

export const UPLOAD_CHUNK_BYTES = 900;
const BATCH_SIZE = 16;
const SEND_INTERVAL_MS = 700;
export function missingChunks(artifact: Buffer, bufferData: Buffer) {
  if (artifact.length !== bufferData.length)
    throw new Error("Upload buffer length differs from artifact");
  const offsets: number[] = [];
  for (let offset = 0; offset < artifact.length; offset += UPLOAD_CHUNK_BYTES)
    if (
      !artifact
        .subarray(offset, offset + UPLOAD_CHUNK_BYTES)
        .equals(bufferData.subarray(offset, offset + UPLOAD_CHUNK_BYTES))
    )
      offsets.push(offset);
  return offsets;
}
export function bufferWrite(
  buffer: PublicKey,
  authority: PublicKey,
  offset: number,
  bytes: Buffer,
) {
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 0xffffffff ||
    bytes.length === 0 ||
    bytes.length > UPLOAD_CHUNK_BYTES
  )
    throw new Error("Invalid loader write range");
  // Canonical loader-v3 bincode: Write enum=1 (u32), offset (u32),
  // Vec length (u64), followed by the exact artifact bytes.
  const data = Buffer.alloc(16 + bytes.length);
  data.writeUInt32LE(1, 0);
  data.writeUInt32LE(offset, 4);
  data.writeBigUInt64LE(BigInt(bytes.length), 8);
  bytes.copy(data, 16);
  return new TransactionInstruction({
    programId: LOADER,
    keys: [
      { pubkey: buffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}
export async function pacedUpload(
  ctx: ChainContext,
  buffer: Keypair,
  artifact: Buffer,
) {
  await ctx.assertNetwork();
  let info = await ctx.connection.getAccountInfo(buffer.publicKey, "finalized");
  if (!info) {
    await sendStep(
      ctx,
      "program:buffer",
      [
        SystemProgram.createAccount({
          fromPubkey: ctx.deployer.publicKey,
          newAccountPubkey: buffer.publicKey,
          space: artifact.length + 37,
          lamports: await ctx.connection.getMinimumBalanceForRentExemption(
            artifact.length + 45,
          ),
          programId: LOADER,
        }),
        new TransactionInstruction({
          programId: LOADER,
          keys: [
            { pubkey: buffer.publicKey, isSigner: false, isWritable: true },
            {
              pubkey: ctx.deployer.publicKey,
              isSigner: false,
              isWritable: false,
            },
          ],
          data: Buffer.alloc(4),
        }),
      ],
      [buffer],
    );
    info = await ctx.connection.getAccountInfo(buffer.publicKey, "finalized");
  }
  verifyBuffer(info, artifact.length, ctx.deployer.publicKey);
  if (!info) throw new Error("Upload buffer not finalized");
  const offsets = missingChunks(artifact, info.data.subarray(37));
  console.info(
    `Paced upload: ${offsets.length} missing chunks; ${UPLOAD_CHUNK_BYTES} bytes/chunk, one send per ${SEND_INTERVAL_MS} ms.`,
  );
  for (let start = 0; start < offsets.length; start += BATCH_SIZE) {
    await ctx.assertNetwork();
    const batch = offsets.slice(start, start + BATCH_SIZE),
      latest = await ctx.connection.getLatestBlockhash("confirmed");
    const signed = batch.map((offset) => {
      const tx = new VersionedTransaction(
        new TransactionMessage({
          payerKey: ctx.deployer.publicKey,
          recentBlockhash: latest.blockhash,
          instructions: [
            bufferWrite(
              buffer.publicKey,
              ctx.deployer.publicKey,
              offset,
              artifact.subarray(offset, offset + UPLOAD_CHUNK_BYTES),
            ),
          ],
        }).compileToV0Message(),
      );
      tx.sign([ctx.deployer]);
      const bytes = tx.serialize();
      if (bytes.length > 1232)
        throw new Error("Paced write exceeds transaction packet size");
      return { offset, bytes };
    });
    await ctx.record("program:upload", {
      status: "submitting",
      ...latest,
      transactions: signed.map(({ offset, bytes }) => ({
        offset,
        signedTransaction: Buffer.from(bytes).toString("base64"),
      })),
    });
    const signatures: string[] = [];
    for (const entry of signed) {
      // No unbounded rebroadcasting; rate-limit errors stop cleanly. The next
      // run derives missing writes from the buffer, not a local progress count.
      signatures.push(
        await ctx.connection.sendRawTransaction(entry.bytes, {
          skipPreflight: false,
          preflightCommitment: "confirmed",
          maxRetries: 0,
        }),
      );
      await Bun.sleep(SEND_INTERVAL_MS);
    }
    let confirmed = false;
    for (let poll = 0; poll < 40; poll++) {
      const statuses = (await ctx.connection.getSignatureStatuses(signatures))
        .value;
      if (statuses.some((status) => status?.err))
        throw new Error(
          "Paced loader write failed; buffer and receipts retained",
        );
      if (
        statuses.every(
          (status) =>
            status &&
            ["confirmed", "finalized"].includes(
              status.confirmationStatus ?? "",
            ),
        )
      ) {
        confirmed = true;
        break;
      }
      if (
        (await ctx.connection.getBlockHeight("confirmed")) >
        latest.lastValidBlockHeight
      )
        break;
      await Bun.sleep(2000);
    }
    if (!confirmed)
      throw new Error(
        "Paced write confirmation incomplete; rerun after checking the retained buffer",
      );
    await ctx.record("program:upload", {
      status: "confirmed",
      signatures,
      offsets: batch,
    });
    console.info(
      `Paced upload: ${Math.min(start + BATCH_SIZE, offsets.length)}/${offsets.length} chunks confirmed.`,
    );
  }
  // Finalization precedes CLI handoff, so stale RPC reads cannot trigger a
  // bulk upload. Never finalize or change buffer/program authority here.
  for (let attempt = 0; attempt < 40; attempt++) {
    await ctx.assertNetwork();
    const final = await ctx.connection.getAccountInfo(
      buffer.publicKey,
      "finalized",
    );
    verifyBuffer(final, artifact.length, ctx.deployer.publicKey);
    if (final?.data.subarray(37).equals(artifact)) {
      await ctx.record("program:upload", {
        status: "finalized",
        artifactBytes: artifact.length,
      });
      return;
    }
    await Bun.sleep(2000);
  }
  throw new Error(
    "Buffer writes are not yet finalized; no deployment attempted",
  );
}
