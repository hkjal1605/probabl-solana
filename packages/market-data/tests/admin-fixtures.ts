/** Test-only evidence, never imported by production runtime modules. */
import { type Address, toHex } from "viem";
import {
  buildCreationEvidence,
  buildResolutionEvidence,
  hashCanonical,
  normalizeGammaMarket,
  type PayoutVector,
} from "../src/index.ts";
import { gammaMarket } from "./helpers.ts";

export const adminFixture = "0x1000000000000000000000000000000000000001" as Address;
export const otherFixture = "0x2000000000000000000000000000000000000002" as Address;
export const registryFixture = "0x3000000000000000000000000000000000000003" as Address;
export const controllerFixture = "0x4000000000000000000000000000000000000004" as Address;
export const creationFixture = () =>
  buildCreationEvidence({
    attachments: [],
    config: {
      baseToken: "0x5000000000000000000000000000000000000005",
      quoteToken: "0x6000000000000000000000000000000000000006",
      baseStep: "1000000000000000",
      priceTickRawX18: "10000",
      minNotional: "1000000",
      maxOrderQuantity: "9007199254740993123456",
      maxOrderNotional: "100000000000",
      maxWalletOpenNotional: "200000000000",
      maxMarketOpenNotional: "400000000000",
      metadataUri: "ipfs://test-market",
      rules: "Test-only event rules",
      tradingOpen: "1800000000",
      tradingCutoff: "1900000000",
    },
    metadata: normalizeGammaMarket(gammaMarket()),
    metadataRawHash: hashCanonical(gammaMarket()),
    metadataSnapshotId: "test-snapshot",
    preparedAt: "2026-09-10T00:00:00Z",
    preparer: adminFixture,
    sourceUrls: ["https://source.example.test/market"],
  });
export const resolutionFixture = (payout: PayoutVector = { yes: "1", no: "0", denominator: "1" }) =>
  buildResolutionEvidence({
    attachments: [],
    conditionId: toHex(1, { size: 32 }),
    marketId: toHex(2, { size: 32 }),
    metadataRawHash: hashCanonical(gammaMarket()),
    metadataSnapshotId: "test-snapshot",
    officialStatus: "resolved",
    officialUrl: "https://source.example.test/resolution",
    payout,
    polygon: { chainId: "137", conditionalTokensAddress: otherFixture },
    polymarketConditionId: normalizeGammaMarket(gammaMarket()).conditionId,
    polymarketYesIndex: "1",
    polymarketNoIndex: "2",
    preparedAt: "2026-09-10T00:00:00Z",
    preparer: adminFixture,
    sourceObservations: [
      {
        observedAt: "2026-09-10T00:00:00Z",
        payout,
        status: "final",
        url: "https://source.example.test/resolution",
      },
    ],
    sourceReference: "ipfs://test-resolution",
  });
