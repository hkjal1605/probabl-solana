import { describe, expect, test } from "bun:test";
import type { Address } from "viem";

import {
  assertAttachmentIntegrity,
  assertEvidenceIntegrity,
  attachmentContentHash,
  buildCreationEvidence,
  buildResolutionEvidence,
  hashCanonical,
  MarketDataError,
  normalizeGammaMarket,
} from "../src/index.ts";
import { gammaMarket } from "./helpers.ts";

const preparer: Address = "0x0000000000000000000000000000000000000001";
const metadata = normalizeGammaMarket(gammaMarket());
const emptyAttachments: unknown[] = [];

describe("admin evidence packets", () => {
  test("canonicalizes creation packets and preserves exact market orientation", () => {
    const input = {
      attachments: emptyAttachments,
      config: {
        baseStep: "1000000000000000000",
        baseToken: "0x0000000000000000000000000000000000000010",
        maxMarketOpenNotional: "1000000000000000000000000",
        maxOrderNotional: "1000000000000000000000",
        maxOrderQuantity: "100000000000000000000",
        maxWalletOpenNotional: "10000000000000000000000",
        metadataUri: "ipfs://market-metadata",
        minNotional: "1000000000000000000",
        priceTickRawX18: "10000000000000000",
        quoteToken: "0x0000000000000000000000000000000000000020",
        rules: metadata.rules,
        tradingCutoff: "1800000000",
        tradingOpen: "1700000000",
      },
      metadata,
      metadataRawHash: hashCanonical(gammaMarket()),
      metadataSnapshotId: "snapshot-1",
      preparedAt: "2026-09-05T00:00:00Z",
      preparer,
      sourceUrls: ["https://gamma-api.polymarket.com/markets/gamma-42"],
    };
    const first = buildCreationEvidence(input);
    const second = buildCreationEvidence({ ...input, config: { ...input.config } });
    expect(first.packetHash).toBe(second.packetHash);
    expect(first.packet.config).toMatchObject({
      polymarketNoIndex: "2",
      polymarketYesIndex: "1",
    });
    assertEvidenceIntegrity(first);
    expect(() =>
      assertEvidenceIntegrity({
        ...first,
        packet: { ...first.packet, sourceUrls: ["https://attacker.invalid/"] },
      }),
    ).toThrow(MarketDataError);
  });

  test("rejects wrong Polygon network and conflicting outcome evidence", () => {
    const base = {
      attachments: [],
      conditionId: `0x${"34".repeat(32)}`,
      marketId: `0x${"56".repeat(32)}`,
      metadataRawHash: hashCanonical(gammaMarket()),
      metadataSnapshotId: "snapshot-1",
      officialStatus: "resolved",
      officialUrl: "https://polymarket.com/event/will-the-event-occur",
      payout: { denominator: "1", no: "0", yes: "1" },
      polygon: {
        blockNumber: "100",
        chainId: "137",
        conditionalTokensAddress: "0x0000000000000000000000000000000000000030",
        transactionHash: `0x${"78".repeat(32)}`,
      },
      polymarketConditionId: metadata.conditionId,
      polymarketNoIndex: "2",
      polymarketYesIndex: "1",
      preparedAt: "2026-09-05T00:00:00Z",
      preparer,
      sourceObservations: [
        {
          observedAt: "2026-09-05T00:00:00Z",
          payout: { denominator: "1", no: "0", yes: "1" },
          status: "final",
          url: "https://polymarket.com/event/will-the-event-occur",
        },
      ],
      sourceReference: "ipfs://resolution-packet",
    };
    expect(() =>
      buildResolutionEvidence({ ...base, polygon: { ...base.polygon, chainId: "1" } }),
    ).toThrow("chainId must be 137");
    expect(() =>
      buildResolutionEvidence({
        ...base,
        sourceObservations: [
          ...base.sourceObservations,
          {
            ...base.sourceObservations[0],
            payout: { denominator: "1", no: "1", yes: "0" },
          },
        ],
      }),
    ).toThrow("disagree");
  });

  test("detects attachment tampering", () => {
    const bytes = new TextEncoder().encode("official screenshot bytes");
    const reference = {
      byteLength: bytes.byteLength.toString(),
      contentHash: attachmentContentHash(bytes),
      filename: "resolution.png",
      mediaType: "image/png",
      uri: "ipfs://resolution.png",
    } as const;
    expect(() => assertAttachmentIntegrity(reference, bytes)).not.toThrow();
    expect(() =>
      assertAttachmentIntegrity(reference, new TextEncoder().encode("tampered screenshot")),
    ).toThrow("invalid");
  });
});
