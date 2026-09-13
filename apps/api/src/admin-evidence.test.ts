import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  type AdminAction,
  type AdminTransactionPreview,
  createEvidenceQueries,
  EvidenceAttachmentStore,
} from "@conditional-stocks/db/evidence";
import { testDatabase } from "@conditional-stocks/db/testing";
import { hashResolutionCommitment } from "@conditional-stocks/domain";
import {
  hashCanonical,
  type NormalizedPolymarketMarket,
  normalizeGammaMarket,
} from "@conditional-stocks/market-data";
import type { Address, Hex } from "viem";
import type { AdminEvidenceEnvironment } from "./admin-environment.ts";
import { AdminEvidenceService } from "./admin-evidence-service.ts";
import { createApp } from "./app.ts";
import type { CanonicalMarket, CanonicalResolution, CanonicalTransaction } from "./chain.ts";
import type { MetadataSnapshot } from "./polymarket-client.ts";

const operatorA: Address = "0x0000000000000000000000000000000000000001";
const outsider: Address = "0x0000000000000000000000000000000000000003";
const registry: Address = "0x0000000000000000000000000000000000000010";
const controller: Address = "0x0000000000000000000000000000000000000020";
const expectedMarketId = `0x${"ab".repeat(32)}` as Hex;
const localConditionId = `0x${"cd".repeat(32)}` as Hex;

const rawMetadata = {
  active: true,
  clobTokenIds: '["111","222"]',
  closed: false,
  conditionId: `0x${"12".repeat(32)}`,
  description: "Binary rules",
  endDate: "2027-01-01T00:00:00Z",
  id: "42",
  negRisk: false,
  outcomes: '["Yes","No"]',
  question: "Will it happen?",
  resolutionSource: "Official source",
  slug: "will-it-happen",
};
const normalized = normalizeGammaMarket(rawMetadata);
const snapshot: MetadataSnapshot = {
  fetchedAtMs: "1788566400000",
  normalized,
  rawHash: hashCanonical(rawMetadata),
  rawPayload: rawMetadata,
  snapshotId: hashCanonical(rawMetadata),
};

const creationInput = {
  attachments: [],
  config: {
    baseStep: "1000000000000000000",
    baseToken: "0x0000000000000000000000000000000000000100",
    maxMarketOpenNotional: "1000000000000000000000000",
    maxOrderNotional: "1000000000000000000000",
    maxOrderQuantity: "100000000000000000000",
    maxWalletOpenNotional: "10000000000000000000000",
    metadataUri: "ipfs://market-metadata",
    minNotional: "1000000000000000000",
    priceTickRawX18: "10000000000000000",
    quoteToken: "0x0000000000000000000000000000000000000200",
    rules: normalized.rules,
    tradingCutoff: "1800000000",
    tradingOpen: "1700000000",
  },
  metadataSnapshotId: snapshot.snapshotId,
  sourceUrls: ["https://gamma-api.polymarket.com/markets/42"],
};

const allChecks = (kind: "creation" | "resolution") =>
  Object.fromEntries(
    (kind === "creation"
      ? [
          "stock-and-quote",
          "condition-id",
          "yes-no-orientation",
          "rules-and-dates",
          "source-and-raw-hash",
        ]
      : [
          "frozen-or-awaiting",
          "condition-id",
          "yes-no-orientation",
          "final-status",
          "polygon-reference",
          "attachments",
          "payout-vector",
        ]
    ).map((key) => [key, true]),
  );

class FakePolymarket {
  tracked = 0;
  async fetchMetadata(): Promise<MetadataSnapshot> {
    return snapshot;
  }
  async metadata(): Promise<MetadataSnapshot> {
    return snapshot;
  }
  async probability(): Promise<unknown> {
    return { midpointX6: "500000", quality: "valid" };
  }
  async snapshot(): Promise<MetadataSnapshot> {
    return snapshot;
  }
  async track(): Promise<{
    conditionId: Hex;
    gammaMarketId: string;
    metadataSnapshotId: string;
    yesTokenId: string;
  }> {
    this.tracked += 1;
    return {
      conditionId: normalized.conditionId,
      gammaMarketId: "42",
      metadataSnapshotId: snapshot.snapshotId,
      yesTokenId: "111",
    };
  }
}

class FakeIndexer {
  marketValue: CanonicalMarket | null = null;
  resolutionValue: CanonicalResolution | null = null;
  transactionValue: CanonicalTransaction | null = {
    blockHash: `0x${"01".repeat(32)}`,
    blockNumber: "100",
    confirmation: "confirmed",
    hash: `0x${"02".repeat(32)}`,
    status: "success",
  };
  async market(): Promise<CanonicalMarket | null> {
    return this.marketValue;
  }
  async resolution(): Promise<CanonicalResolution | null> {
    return this.resolutionValue;
  }
  async transaction(): Promise<CanonicalTransaction | null> {
    return this.transactionValue;
  }
}

class FakeAdminChain {
  transactionMatches = true;

  async assertTransactionMatches(): Promise<void> {
    if (!this.transactionMatches) throw new Error("canonical transaction mismatch");
  }

  preview(action: AdminAction, packetHash: Hex): AdminTransactionPreview {
    return {
      action,
      chainId: 31337,
      data: `0x${action === "create-market" ? "11" : action === "begin-resolution" ? "22" : "33"}`,
      expectedMarketId,
      from: operatorA,
      packetHash,
      previewId: crypto.randomUUID(),
      to: action === "resolve-market" ? controller : registry,
      value: "0",
    };
  }
  async creationPreview(envelope: { packetHash: Hex }) {
    return this.preview("create-market", envelope.packetHash);
  }
  async beginResolutionPreview(envelope: { packetHash: Hex }) {
    return this.preview("begin-resolution", envelope.packetHash);
  }
  async resolutionPreview(envelope: { packetHash: Hex }) {
    return this.preview("resolve-market", envelope.packetHash);
  }
}

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { force: true, recursive: true });
});

const setup = async () => {
  const fixture = await testDatabase();
  const environment: AdminEvidenceEnvironment = {
    attachmentPublicBaseUrl: "https://evidence.example.test",
    marketAdmin: operatorA,
    polymarketIngestorToken: "test-internal-token",
    polymarketIngestorUrl: "http://127.0.0.1:42073",
    resolutionController: controller,
  };
  const store = createEvidenceQueries(fixture.database);
  const indexer = new FakeIndexer();
  const polymarket = new FakePolymarket();
  const chain = new FakeAdminChain();
  const service = new AdminEvidenceService(
    environment,
    store,
    new EvidenceAttachmentStore(fixture.database, environment.attachmentPublicBaseUrl),
    chain,
    indexer,
    polymarket,
  );
  return { chain, indexer, polymarket, service, store };
};

const canonicalMarket = (packet: {
  config: {
    baseStep: string;
    baseToken: string;
    maxMarketOpenNotional: string;
    maxOrderNotional: string;
    maxOrderQuantity: string;
    maxWalletOpenNotional: string;
    metadataHash?: Hex;
    minNotional: string;
    priceTickRawX18: string;
    quoteToken: string;
    rulesHash?: Hex;
    tradingCutoff: string;
    tradingOpen: string;
  };
  polymarket?: NormalizedPolymarketMarket;
}): CanonicalMarket => ({
  baseTokenDecimals: 18,
  quoteTokenDecimals: 18,
  protocolVersion: 2,
  priceFormat: "raw-unit-ratio-x18",
  baseStep: packet.config.baseStep ?? "1",
  baseToken: packet.config.baseToken as Address,
  conditionId: localConditionId,
  id: expectedMarketId,
  maxMarketOpenNotional: packet.config.maxMarketOpenNotional ?? "1",
  maxOrderNotional: packet.config.maxOrderNotional ?? "1",
  maxOrderQuantity: packet.config.maxOrderQuantity ?? "1",
  maxWalletOpenNotional: packet.config.maxWalletOpenNotional ?? "1",
  metadataHash: packet.config.metadataHash ?? (`0x${"00".repeat(32)}` as Hex),
  minNotional: packet.config.minNotional ?? "1",
  polymarketConditionId: normalized.conditionId,
  polymarketNoIndex: "2",
  polymarketYesIndex: "1",
  priceTickRawX18: packet.config.priceTickRawX18 ?? "1",
  quoteToken: packet.config.quoteToken as Address,
  rulesHash: packet.config.rulesHash ?? (`0x${"00".repeat(32)}` as Hex),
  state: 1,
  stateReasonHash: `0x${"00".repeat(32)}`,
  tradingCutoff: packet.config.tradingCutoff ?? "1",
  tradingOpen: packet.config.tradingOpen ?? "0",
});

describe("admin evidence workflow", () => {
  test("all privileged API operations reject wallets other than MARKET_ADMIN before reads or writes", async () => {
    const { service, store } = await setup();
    for (const stranger of [outsider, "0x0000000000000000000000000000000000000002" as Address]) {
      for (const action of [
        () => service.fetchPolymarketMetadata({}, stranger),
        () => service.prepareCreation({}, stranger),
        () => service.prepareResolution({}, stranger),
        () => service.review(expectedMarketId, {}, stranger),
        () => service.transaction(expectedMarketId, stranger),
        () => service.verifyTransaction(expectedMarketId, {}, stranger),
        () => service.reconcile(expectedMarketId, {}, stranger),
        () => service.packet(expectedMarketId, stranger),
        () => service.packets(stranger),
        () => service.history(stranger),
      ])
        await expect(action()).rejects.toThrow("MARKET_ADMIN");
    }
    expect(await store.packetViews()).toEqual([]);
    await store.close();
  });

  test("single-admin rejection stays final and cannot generate a transaction", async () => {
    const { service, store } = await setup();
    const packet = await service.prepareCreation(creationInput, operatorA);
    await service.review(
      packet.envelope.packetHash,
      { decision: "reject", checklist: {}, notes: "Incorrect source" },
      operatorA,
    );
    await expect(service.transaction(packet.envelope.packetHash, operatorA)).rejects.toThrow(
      "approval",
    );
    await expect(
      service.review(
        packet.envelope.packetHash,
        { decision: "approve", checklist: allChecks("creation") },
        operatorA,
      ),
    ).rejects.toThrow("already been reviewed");
    await store.close();
  });
  test("allows MARKET_ADMIN to prepare, approve and execute exact creation calldata", async () => {
    const { chain, indexer, polymarket, service, store } = await setup();
    await expect(service.prepareCreation(creationInput, outsider)).rejects.toThrow("MARKET_ADMIN");
    const prepared = await service.prepareCreation(creationInput, operatorA);
    expect(prepared.status).toBe("prepared");
    await expect(service.transaction(prepared.envelope.packetHash, operatorA)).rejects.toThrow(
      "approval",
    );
    await expect(
      service.review(
        prepared.envelope.packetHash,
        { checklist: allChecks("creation"), decision: "approve" },
        outsider,
      ),
    ).rejects.toThrow("MARKET_ADMIN");
    await expect(
      (async () =>
        await service.review(
          prepared.envelope.packetHash,
          { checklist: {}, decision: "approve" },
          operatorA,
        ))(),
    ).rejects.toThrow("checklist");
    const approved = await service.review(
      prepared.envelope.packetHash,
      { checklist: allChecks("creation"), decision: "approve" },
      operatorA,
    );
    expect(approved.status).toBe("approved");
    expect(approved.reviews[0]?.reviewer.toLowerCase()).toBe(operatorA.toLowerCase());
    await expect(
      service.review(
        prepared.envelope.packetHash,
        { checklist: allChecks("creation"), decision: "reject" },
        operatorA,
      ),
    ).rejects.toThrow("already been reviewed");
    const preview = await service.transaction(prepared.envelope.packetHash, operatorA);
    expect(
      await service.verifyTransaction(
        prepared.envelope.packetHash,
        {
          action: preview.action,
          chainId: preview.chainId,
          data: preview.data,
          from: preview.from,
          to: preview.to,
          value: preview.value,
        },
        operatorA,
      ),
    ).toMatchObject({ matches: true });
    await expect(
      (async () =>
        await service.verifyTransaction(
          prepared.envelope.packetHash,
          { ...preview, data: "0xdeadbeef" },
          operatorA,
        ))(),
    ).rejects.toThrow("does not match");

    chain.transactionMatches = false;
    await expect(
      service.reconcile(
        prepared.envelope.packetHash,
        { action: "create-market", transactionHash: `0x${"02".repeat(32)}` },
        operatorA,
      ),
    ).rejects.toThrow("canonical transaction mismatch");
    chain.transactionMatches = true;

    if (prepared.envelope.packet.kind !== "market-creation") throw new Error("wrong packet kind");
    indexer.marketValue = canonicalMarket({ config: prepared.envelope.packet.config });
    await expect(service.marketProbability(expectedMarketId)).resolves.toMatchObject({
      informationalOnly: true,
      probability: { midpointX6: "500000", quality: "valid" },
      settlementAuthority: "manual-admin-only",
    });
    const reconciled = await service.reconcile(
      prepared.envelope.packetHash,
      { action: "create-market", transactionHash: `0x${"02".repeat(32)}` },
      operatorA,
    );
    expect(reconciled.action).toBe("create-market");
    expect(polymarket.tracked).toBe(1);
    expect(await store.observations(prepared.envelope.packetHash)).toHaveLength(1);
    await store.close();
  });

  test("anchors reviewed resolution evidence before exact manual resolution", async () => {
    const { indexer, service, store } = await setup();
    indexer.marketValue = {
      ...canonicalMarket({ config: creationInput.config }),
      metadataHash: `0x${"03".repeat(32)}`,
      rulesHash: `0x${"04".repeat(32)}`,
      state: 3,
    };
    const resolutionInput = {
      attachments: [
        {
          contentBase64: Buffer.from("official evidence").toString("base64"),
          filename: "official.txt",
          mediaType: "text/plain",
        },
      ],
      marketId: expectedMarketId,
      metadataSnapshotId: snapshot.snapshotId,
      officialStatus: "resolved-final",
      officialUrl: normalized.canonicalUrl,
      payout: { denominator: "1", no: "0", yes: "1" },
      polygon: {
        blockNumber: "70000000",
        chainId: "137",
        conditionalTokensAddress: "0x0000000000000000000000000000000000000300",
        transactionHash: `0x${"05".repeat(32)}`,
      },
      sourceObservations: [
        {
          observedAt: "2026-09-05T00:00:00Z",
          payout: { denominator: "1", no: "0", yes: "1" },
          status: "final",
          url: normalized.canonicalUrl,
        },
      ],
      sourceReference: "ipfs://approved-resolution-packet",
    };
    const prepared = await service.prepareResolution(resolutionInput, operatorA);
    const attachment = prepared.envelope.packet.attachments[0];
    if (!attachment) throw new Error("attachment missing");
    const app = createApp(undefined, service);
    const attachmentPath = `/v1/attachments/${attachment.contentHash.slice(2)}`;
    expect((await app.request(attachmentPath)).status).toBe(404);
    await expect(
      service.prepareResolution(
        {
          ...resolutionInput,
          payout: { denominator: "1", no: "1", yes: "0" },
          sourceObservations: resolutionInput.sourceObservations.map((observation) => ({
            ...observation,
            payout: { denominator: "1", no: "1", yes: "0" },
          })),
        },
        operatorA,
      ),
    ).rejects.toThrow("different payout");
    await service.review(
      prepared.envelope.packetHash,
      { checklist: allChecks("resolution"), decision: "approve" },
      operatorA,
    );
    const published = await app.request(attachmentPath);
    expect(published.status).toBe(200);
    expect(published.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await published.text()).toBe("official evidence");
    const begin = await service.transaction(prepared.envelope.packetHash, operatorA);
    expect(begin.action).toBe("begin-resolution");

    if (!indexer.marketValue) throw new Error("market missing");
    indexer.marketValue = {
      ...indexer.marketValue,
      state: 4,
      stateReasonHash: hashResolutionCommitment({
        chainId: 31337n,
        controller,
        marketId: expectedMarketId,
        yesPayout: 1n,
        noPayout: 0n,
        payoutDenominator: 1n,
        evidenceHash: prepared.envelope.packetHash,
        evidenceUri: resolutionInput.sourceReference,
      }),
    };
    await service.reconcile(
      prepared.envelope.packetHash,
      { action: "begin-resolution", transactionHash: `0x${"06".repeat(32)}` },
      operatorA,
    );
    const resolve = await service.transaction(prepared.envelope.packetHash, operatorA);
    expect(resolve.action).toBe("resolve-market");
    indexer.resolutionValue = {
      admin: operatorA,
      evidenceHash: prepared.envelope.packetHash,
      evidenceUri: "ipfs://approved-resolution-packet",
      noPayout: "0",
      payoutDenominator: "1",
      transactionHash: `0x${"07".repeat(32)}`,
      yesPayout: "1",
    };
    await service.reconcile(
      prepared.envelope.packetHash,
      { action: "resolve-market", transactionHash: `0x${"07".repeat(32)}` },
      operatorA,
    );
    expect((await service.publicResolutionEvidence(expectedMarketId)).status).toBe("approved");
    expect(await store.observations(prepared.envelope.packetHash)).toHaveLength(2);
    await store.close();
  });
});
