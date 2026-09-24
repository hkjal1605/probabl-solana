/** The live index against a real validator running the Yellowstone plugin.
 * Runs inside `scripts/solana/test-application.ts` (fresh deployment fixture). */
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import YellowstoneClient from "@triton-one/yellowstone-grpc";
import { SolanaClient } from "@conditional-stocks/solana-client";
import { ChainRelay, LiveIndex, relayClientFactory, type GeyserClient, type GeyserStream } from "../src/live/index.ts";
import { snapshot, type Snapshot } from "../src/projection.ts";

const enabled = process.env.SOLANA_APP_E2E === "1" && Boolean(process.env.YELLOWSTONE_GRPC_URL);

/** Every decoded program account, comparable across sources. */
function image(s: Snapshot) {
  const rows: Record<string, string> = {};
  for (const kind of ["markets", "orders", "wallets", "traders", "pools", "credits", "delegations"] as const)
    for (const [key, value] of s[kind] ?? []) rows[`${kind}:${key}`] = JSON.stringify(value);
  rows.config = JSON.stringify(s.config);
  return rows;
}

async function until(condition: () => boolean | Promise<boolean>, ms: number, label: string) {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Timed out: " + label);
    await Bun.sleep(100);
  }
}

test.skipIf(!enabled)(
  "the compressed stream, and an API-style consumer of its local relay, equal RPC and survive a dropped stream",
  async () => {
    const deployment = await Bun.file(resolve(process.env.SOLANA_FIXTURE_DIR ?? ".local", "deployment.json")).json();
    const client = new SolanaClient(deployment);
    const url = process.env.YELLOWSTONE_GRPC_URL!;
    let clients = 0;
    const compression: boolean[] = [];
    const errors: unknown[] = [];
    const relay = new ChainRelay();
    const relayUrl = `http://127.0.0.1:${relay.serve(0).port}`;
    const live = new LiveIndex({
      client,
      geyser: (options) => {
        clients++;
        compression.push(options.compression);
        return new YellowstoneClient(url, undefined, options.compression ? { grpcDefaultCompressionAlgorithm: 1 } : {}, {
          enabled: false,
        }) as unknown as GeyserClient;
      },
      onEvent: (event) => relay.publish(event),
      onError: (error) => errors.push(error),
    });
    await live.start();
    const consumer = new LiveIndex({ client, geyser: relayClientFactory(relayUrl), source: { backoffMs: 50 } });
    try {
      await until(() => live.health().healthy, 30_000, "upstream healthy");
      await consumer.start();
      await until(() => consumer.health().healthy, 30_000, "consumer healthy");
      await until(() => live.health().healthy, 30_000, "healthy");
      const compare = async () => {
        const direct = await snapshot(client, "finalized");
        await until(() => live.finalized().slot >= direct.slot, 30_000, "finalized catch-up");
        expect(image(live.finalized())).toEqual(image(direct));
        return direct.slot;
      };
      const before = await compare();
      // Drop the stream: the source reconnects and replays from finalized + 1.
      const source = (live as unknown as { source: { stream?: GeyserStream } }).source;
      source.stream!.destroy!(new Error("test: dropped stream"));
      await until(() => clients === 2 && live.health().connected && live.health().healthy, 30_000, "reconnected");
      await until(() => live.health().finalizedSlot > before + 2, 30_000, "stream advances");
      await compare();
      expect(image(live.confirmed())).toEqual(image(await snapshot(client, "confirmed")));
      expect(errors.map(String)).toContain("Error: test: dropped stream");
      // The plugin accepts zstd: every connection streamed compressed.
      expect(compression).toEqual([true, true]);
      // The relay consumer follows the same chain without its own stream.
      await until(() => consumer.finalized().slot >= live.finalized().slot, 30_000, "consumer catch-up");
      const direct = await snapshot(client, "finalized");
      await until(() => consumer.finalized().slot >= direct.slot, 30_000, "consumer finalized");
      expect(image(consumer.finalized())).toEqual(image(direct));
    } finally {
      consumer.stop();
      live.stop();
      relay.stop();
    }
  },
  120_000,
);
