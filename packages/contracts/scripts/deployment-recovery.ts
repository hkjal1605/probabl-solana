import { readFileSync } from "node:fs";
import { type Address, getAddress, type Hash, type Hex } from "viem";
import type { createPublicChainClient } from "./lib.ts";

/** Replay only confirmed transactions with exactly matching sender, nonce, destination and data. */
export async function deploymentRecovery(
  client: Awaited<ReturnType<typeof createPublicChainClient>>["publicClient"],
  account: Address,
  chainId: number,
  journalPath?: string,
) {
  let hashes: Hash[] = [];
  let startingNonce = 0;
  if (journalPath) {
    const entries = readFileSync(journalPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const start = entries[0];
    if (
      start?.event !== "started" ||
      start.chainId !== chainId ||
      getAddress(start.deployer) !== getAddress(account) ||
      !Number.isSafeInteger(start.nonce) ||
      start.nonce < 0 ||
      entries.some((entry) => entry.event === "completed")
    )
      throw new Error("Journal does not describe an incomplete deployment for this signer/chain");
    startingNonce = start.nonce;
    hashes = [
      ...new Set<Hash>(
        entries
          .filter((entry) => entry.event === "broadcast")
          .map((entry) => entry.transactionHash),
      ),
    ];
    if (
      hashes.length === 0 ||
      hashes.length > 16 ||
      hashes.some((hash) => !/^0x[0-9a-fA-F]{64}$/.test(hash))
    )
      throw new Error("Invalid deployment journal transactions");
    const nonce = await client.getTransactionCount({ address: account, blockTag: "pending" });
    if (nonce !== startingNonce + hashes.length)
      throw new Error("Unexpected intervening or unconfirmed deployer transaction");
  }
  let cursor = 0;
  return {
    async referenceBlock(): Promise<bigint | undefined> {
      const hash = hashes[cursor];
      if (!hash) return undefined;
      const receipt = await client.getTransactionReceipt({ hash });
      const blockNumber = receipt.blockNumber - 1n;
      if (
        (await client.getTransactionCount({ address: account, blockNumber })) !==
        startingNonce + cursor
      )
        throw new Error("Historical constructor simulation cannot isolate this deployment nonce");
      return blockNumber;
    },
    async send(data: Hex, to: Address | null, broadcast: () => Promise<Hash>): Promise<Hash> {
      const hash = hashes[cursor];
      if (!hash) return broadcast();
      const transaction = await client.getTransaction({ hash });
      const receipt = await client.getTransactionReceipt({ hash });
      if (
        getAddress(transaction.from) !== getAddress(account) ||
        transaction.nonce !== startingNonce + cursor ||
        transaction.chainId !== chainId ||
        transaction.input.toLowerCase() !== data.toLowerCase() ||
        (transaction.to?.toLowerCase() ?? null) !== (to?.toLowerCase() ?? null) ||
        receipt.status !== "success"
      )
        throw new Error(`Recorded transaction ${cursor} does not match this deployment step`);
      cursor += 1;
      console.info(
        JSON.stringify({
          event: "deployment.reused",
          transactionHash: hash,
          blockNumber: receipt.blockNumber.toString(),
        }),
      );
      return hash;
    },
    assertConsumed() {
      if (cursor !== hashes.length) throw new Error("Unused recorded deployment transactions");
    },
  };
}
