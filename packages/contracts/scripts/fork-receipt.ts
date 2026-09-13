import type { createPublicClient, Hex } from "viem";

/** Local Anvil mining/receipt polling that remains valid when test snapshots rewind height. */
export async function forkReceipt(client: ReturnType<typeof createPublicClient>, hash: Hex) {
  await client.request({ method: "evm_mine", params: [] } as never);
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return await client.getTransactionReceipt({ hash });
    } catch (error) {
      if (attempt === 99) throw error;
      await Bun.sleep(50);
    }
  }
  throw new Error(`No local receipt for ${hash}`);
}
