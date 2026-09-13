import { type Address, getAddress, type Hex, isAddress, isHex, keccak256 } from "viem";
import { address as solanaAddress, digest, hex, unsigned, U128_MAX } from "./protocol.ts";

export interface EvidenceDeployment {
  genesisHash: string;
  programId: string;
  config: string;
}

import {
  decimalInteger,
  hashCanonical,
  MarketDataError,
  object,
  requiredString,
} from "@conditional-stocks/market-data";
import {
  type NormalizedPolymarketMarket,
  noOutcome,
  type PolymarketOutcome,
  yesOutcome,
} from "@conditional-stocks/market-data";

export interface AttachmentReference {
  byteLength: string;
  contentHash: Hex;
  filename: string;
  mediaType: string;
  uri: string;
}

export interface MarketConfigEvidence {
  baseStep: string;
  baseToken: string;
  maxMarketOpenNotional: string;
  maxOrderNotional: string;
  maxOrderQuantity: string;
  maxWalletOpenNotional: string;
  metadataHash: Hex;
  metadataUri: string;
  minNotional: string;
  polymarketConditionId: Hex;
  polymarketNoIndex: string;
  polymarketYesIndex: string;
  priceTickRawX18: string;
  quoteToken: string;
  rulesHash: Hex;
  tradingCutoff: string;
  tradingOpen: string;
}

export interface CreationEvidencePacket {
  deployment: EvidenceDeployment;
  attachments: AttachmentReference[];
  config: MarketConfigEvidence;
  kind: "market-creation";
  polymarket: {
    canonicalUrl: string;
    conditionId: Hex;
    endTime: string;
    gammaMarketId: string;
    metadataRawHash: Hex;
    metadataSnapshotId: string;
    no: PolymarketOutcome;
    question: string;
    resolutionSource: string;
    rules: string;
    yes: PolymarketOutcome;
  };
  preparedAt: string;
  preparer: string;
  schemaVersion: 3;
  sourceUrls: string[];
}

export interface PayoutVector {
  denominator: "1" | "2";
  no: "0" | "1";
  yes: "0" | "1";
}

export interface ResolutionEvidencePacket {
  deployment: EvidenceDeployment;
  attachments: AttachmentReference[];
  kind: "market-resolution";
  localMarket: {
    conditionId: string;
    marketId: string;
    polymarketConditionId: Hex;
    polymarketNoIndex: string;
    polymarketYesIndex: string;
  };
  officialPolymarket: {
    metadataRawHash: Hex;
    metadataSnapshotId: string;
    status: string;
    url: string;
  };
  payout: PayoutVector;
  polygon: {
    blockHash: Hex | null;
    blockNumber: string | null;
    chainId: "137";
    conditionalTokensAddress: Address;
    transactionHash: Hex | null;
  };
  preparedAt: string;
  preparer: string;
  schemaVersion: 2;
  sourceObservations: Array<{
    observedAt: string;
    payout: PayoutVector;
    status: string;
    url: string;
  }>;
  sourceReference: string;
}

export interface EvidenceEnvelope<T extends CreationEvidencePacket | ResolutionEvidencePacket> {
  packet: T;
  packetHash: Hex;
}

const address = (value: unknown, name: string): Address => {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new MarketDataError("INVALID_EVIDENCE", `${name} is not an address`);
  }
  return getAddress(value);
};

const hex32 = (value: unknown, name: string): Hex => {
  if (typeof value !== "string" || !isHex(value, { strict: true }) || value.length !== 66) {
    throw new MarketDataError("INVALID_EVIDENCE", `${name} must be bytes32`);
  }
  return value.toLowerCase() as Hex;
};

const isoTime = (value: unknown, name: string): string => {
  const input = requiredString(value, name, 128);
  const parsed = Date.parse(input);
  if (!Number.isFinite(parsed)) throw new MarketDataError("INVALID_EVIDENCE", `${name} is invalid`);
  return new Date(parsed).toISOString();
};

const secureUrl = (value: unknown, name: string): string => {
  const input = requiredString(value, name, 2_048);
  const url = new URL(input);
  if (url.protocol !== "https:" && url.protocol !== "ipfs:") {
    throw new MarketDataError("INVALID_EVIDENCE", `${name} must use HTTPS or IPFS`);
  }
  return url.toString();
};

export const parseAttachments = (input: unknown): AttachmentReference[] => {
  if (!Array.isArray(input) || input.length > 32) {
    throw new MarketDataError("INVALID_EVIDENCE", "attachments must contain at most 32 items");
  }
  const seen = new Set<string>();
  return input.map((item, index) => {
    const raw = object(item, `attachments[${index}]`);
    const reference: AttachmentReference = {
      byteLength: decimalInteger(raw.byteLength, `attachments[${index}].byteLength`, true),
      contentHash: hex32(raw.contentHash, `attachments[${index}].contentHash`),
      filename: requiredString(raw.filename, `attachments[${index}].filename`, 256),
      mediaType: requiredString(raw.mediaType, `attachments[${index}].mediaType`, 128),
      uri: secureUrl(raw.uri, `attachments[${index}].uri`),
    };
    if (seen.has(reference.contentHash)) {
      throw new MarketDataError("INVALID_EVIDENCE", "duplicate attachment hash");
    }
    seen.add(reference.contentHash);
    return reference;
  });
};

export const payoutVector = (input: unknown): PayoutVector => {
  const raw = object(input, "payout");
  const yes = decimalInteger(raw.yes, "payout.yes", true);
  const no = decimalInteger(raw.no, "payout.no", true);
  const denominator = decimalInteger(raw.denominator, "payout.denominator");
  if (
    !(
      (yes === "1" && no === "0" && denominator === "1") ||
      (yes === "0" && no === "1" && denominator === "1") ||
      (yes === "1" && no === "1" && denominator === "2")
    )
  ) {
    throw new MarketDataError("INVALID_PAYOUT", "payout must be YES, NO, or invalid 50/50");
  }
  return { denominator, no, yes } as PayoutVector;
};

const parseConfig = (
  input: unknown,
  metadata: NormalizedPolymarketMarket,
): MarketConfigEvidence => {
  const raw = object(input, "config");
  const metadataUri = secureUrl(raw.metadataUri, "config.metadataUri");
  const rules = requiredString(raw.rules, "config.rules", 64_000);
  const yes = yesOutcome(metadata);
  const no = noOutcome(metadata);
  const config: MarketConfigEvidence = {
    baseStep: decimalInteger(raw.baseStep, "config.baseStep"),
    baseToken: solanaAddress(raw.baseToken),
    maxMarketOpenNotional: decimalInteger(
      raw.maxMarketOpenNotional,
      "config.maxMarketOpenNotional",
    ),
    maxOrderNotional: decimalInteger(raw.maxOrderNotional, "config.maxOrderNotional"),
    maxOrderQuantity: decimalInteger(raw.maxOrderQuantity, "config.maxOrderQuantity"),
    maxWalletOpenNotional: decimalInteger(
      raw.maxWalletOpenNotional,
      "config.maxWalletOpenNotional",
    ),
    metadataHash: hex(digest(metadataUri)),
    metadataUri,
    minNotional: decimalInteger(raw.minNotional, "config.minNotional"),
    polymarketConditionId: metadata.conditionId,
    polymarketNoIndex: no.indexSet,
    polymarketYesIndex: yes.indexSet,
    priceTickRawX18: decimalInteger(raw.priceTickRawX18, "config.priceTickRawX18"),
    quoteToken: solanaAddress(raw.quoteToken),
    rulesHash: hex(digest(rules)),
    tradingCutoff: decimalInteger(raw.tradingCutoff, "config.tradingCutoff"),
    tradingOpen: decimalInteger(raw.tradingOpen, "config.tradingOpen", true),
  };
  if (BigInt(config.tradingCutoff) <= BigInt(config.tradingOpen)) {
    throw new MarketDataError("INVALID_EVIDENCE", "trading cutoff must follow opening");
  }
  if (config.baseToken === config.quoteToken) {
    throw new MarketDataError("INVALID_EVIDENCE", "base and quote tokens must differ");
  }
  for (const field of [
    "baseStep",
    "maxMarketOpenNotional",
    "maxOrderNotional",
    "maxOrderQuantity",
    "maxWalletOpenNotional",
    "minNotional",
  ] as const)
    unsigned(config[field]);
  unsigned(config.priceTickRawX18, U128_MAX);
  unsigned(config.tradingOpen, (1n << 63n) - 1n);
  unsigned(config.tradingCutoff, (1n << 63n) - 1n);
  if (new TextEncoder().encode(metadataUri).length > 512)
    throw new Error("Metadata URI exceeds the onchain limit");
  return config;
};

const sourceUrls = (input: unknown): string[] => {
  if (!Array.isArray(input) || input.length === 0 || input.length > 16) {
    throw new MarketDataError("INVALID_EVIDENCE", "sourceUrls must contain 1-16 entries");
  }
  return [...new Set(input.map((value, index) => secureUrl(value, `sourceUrls[${index}]`)))];
};

export const buildCreationEvidence = (input: {
  deployment: EvidenceDeployment;
  attachments: unknown;
  config: unknown;
  metadata: NormalizedPolymarketMarket;
  metadataRawHash: Hex;
  metadataSnapshotId: string;
  preparedAt: string;
  preparer: string;
  sourceUrls: unknown;
}): EvidenceEnvelope<CreationEvidencePacket> => {
  const yes = yesOutcome(input.metadata);
  const no = noOutcome(input.metadata);
  const config = parseConfig(input.config, input.metadata);
  const packet: CreationEvidencePacket = {
    deployment: validateDeployment(input.deployment),
    attachments: parseAttachments(input.attachments),
    config,
    kind: "market-creation",
    polymarket: {
      canonicalUrl: input.metadata.canonicalUrl,
      conditionId: input.metadata.conditionId,
      endTime: input.metadata.endTime,
      gammaMarketId: input.metadata.gammaMarketId,
      metadataRawHash: hex32(input.metadataRawHash, "metadataRawHash"),
      metadataSnapshotId: requiredString(input.metadataSnapshotId, "metadataSnapshotId", 256),
      no,
      question: input.metadata.question,
      resolutionSource: input.metadata.resolutionSource,
      rules: input.metadata.rules,
      yes,
    },
    preparedAt: isoTime(input.preparedAt, "preparedAt"),
    preparer: solanaAddress(input.preparer),
    schemaVersion: 3,
    sourceUrls: sourceUrls(input.sourceUrls),
  };
  return { packet, packetHash: hashCanonical(packet) };
};

export const buildResolutionEvidence = (input: {
  deployment: EvidenceDeployment;
  attachments: unknown;
  conditionId: unknown;
  marketId: unknown;
  metadataRawHash: unknown;
  metadataSnapshotId: unknown;
  officialStatus: unknown;
  officialUrl: unknown;
  payout: unknown;
  polygon: unknown;
  polymarketConditionId: unknown;
  polymarketNoIndex: unknown;
  polymarketYesIndex: unknown;
  preparedAt: unknown;
  preparer: unknown;
  sourceObservations: unknown;
  sourceReference: unknown;
}): EvidenceEnvelope<ResolutionEvidencePacket> => {
  const payout = payoutVector(input.payout);
  const polygonRaw = object(input.polygon, "polygon");
  if (polygonRaw.chainId !== "137") {
    throw new MarketDataError("WRONG_NETWORK", "Polygon evidence chainId must be 137");
  }
  if (!Array.isArray(input.sourceObservations) || input.sourceObservations.length === 0) {
    throw new MarketDataError("INVALID_EVIDENCE", "source observations are required");
  }
  const observations = input.sourceObservations.map((item, index) => {
    const raw = object(item, `sourceObservations[${index}]`);
    return {
      observedAt: isoTime(raw.observedAt, `sourceObservations[${index}].observedAt`),
      payout: payoutVector(raw.payout),
      status: requiredString(raw.status, `sourceObservations[${index}].status`, 256),
      url: secureUrl(raw.url, `sourceObservations[${index}].url`),
    };
  });
  if (
    observations.some((observation) => hashCanonical(observation.payout) !== hashCanonical(payout))
  ) {
    throw new MarketDataError("CONFLICTING_EVIDENCE", "source observations disagree on payout");
  }
  const optionalHex = (value: unknown, name: string): Hex | null =>
    value === undefined || value === null || value === "" ? null : hex32(value, name);
  const optionalInteger = (value: unknown, name: string): string | null =>
    value === undefined || value === null || value === ""
      ? null
      : decimalInteger(value, name, true);
  const packet: ResolutionEvidencePacket = {
    deployment: validateDeployment(input.deployment),
    attachments: parseAttachments(input.attachments),
    kind: "market-resolution",
    localMarket: {
      conditionId: solanaAddress(input.conditionId),
      marketId: solanaAddress(input.marketId),
      polymarketConditionId: hex32(input.polymarketConditionId, "polymarketConditionId"),
      polymarketNoIndex: decimalInteger(input.polymarketNoIndex, "polymarketNoIndex"),
      polymarketYesIndex: decimalInteger(input.polymarketYesIndex, "polymarketYesIndex"),
    },
    officialPolymarket: {
      metadataRawHash: hex32(input.metadataRawHash, "metadataRawHash"),
      metadataSnapshotId: requiredString(input.metadataSnapshotId, "metadataSnapshotId", 256),
      status: requiredString(input.officialStatus, "officialStatus", 256),
      url: secureUrl(input.officialUrl, "officialUrl"),
    },
    payout,
    polygon: {
      blockHash: optionalHex(polygonRaw.blockHash, "polygon.blockHash"),
      blockNumber: optionalInteger(polygonRaw.blockNumber, "polygon.blockNumber"),
      chainId: "137",
      conditionalTokensAddress: address(
        polygonRaw.conditionalTokensAddress,
        "polygon.conditionalTokensAddress",
      ),
      transactionHash: optionalHex(polygonRaw.transactionHash, "polygon.transactionHash"),
    },
    preparedAt: isoTime(input.preparedAt, "preparedAt"),
    preparer: solanaAddress(input.preparer),
    schemaVersion: 2,
    sourceObservations: observations,
    sourceReference: secureUrl(input.sourceReference, "sourceReference"),
  };
  return { packet, packetHash: hashCanonical(packet) };
};

export const assertEvidenceIntegrity = <
  T extends CreationEvidencePacket | ResolutionEvidencePacket,
>(
  envelope: EvidenceEnvelope<T>,
): void => {
  if (
    (envelope.packet.kind === "market-creation" && envelope.packet.schemaVersion !== 3) ||
    (envelope.packet.kind === "market-resolution" && envelope.packet.schemaVersion !== 2)
  ) {
    throw new MarketDataError(
      "INVALID_EVIDENCE",
      "Legacy EVM evidence cannot authorize a Solana transaction",
      409,
    );
  }
  validateDeployment(envelope.packet.deployment);
  if (envelope.packet.kind === "market-resolution") {
    payoutVector(envelope.packet.payout);
    if (envelope.packet.localMarket.conditionId !== envelope.packet.localMarket.marketId)
      throw new Error("Solana condition must identify the market PDA");
    if (new TextEncoder().encode(envelope.packet.sourceReference).length > 512)
      throw new Error("Evidence URI exceeds the onchain limit");
  }
  if (hashCanonical(envelope.packet) !== envelope.packetHash) {
    throw new MarketDataError(
      "TAMPERED_EVIDENCE",
      "packet hash does not match packet contents",
      409,
    );
  }
};

export const attachmentContentHash = (bytes: Uint8Array): Hex => keccak256(bytes);

function validateDeployment(value: EvidenceDeployment): EvidenceDeployment {
  return {
    genesisHash: solanaAddress(value.genesisHash),
    programId: solanaAddress(value.programId),
    config: solanaAddress(value.config),
  };
}

export const assertAttachmentIntegrity = (
  reference: AttachmentReference,
  bytes: Uint8Array,
): void => {
  if (
    attachmentContentHash(bytes) !== reference.contentHash ||
    BigInt(bytes.byteLength) !== BigInt(reference.byteLength)
  ) {
    throw new MarketDataError(
      "TAMPERED_ATTACHMENT",
      `attachment ${reference.filename} is invalid`,
      409,
    );
  }
};
