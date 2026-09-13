import {
  manualResolutionControllerAbi,
  marketRegistryAbi,
} from "@conditional-stocks/contract-bindings";
import type { AdminAction, AdminTransactionPreview } from "@conditional-stocks/db/evidence";
import {
  assertMarketUnits,
  hashResolutionCommitment,
  PRICE_FORMAT,
} from "@conditional-stocks/domain";
import type {
  CreationEvidencePacket,
  EvidenceEnvelope,
  ResolutionEvidencePacket,
} from "@conditional-stocks/market-data";
import {
  type Address,
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  type Hex,
  http,
  keccak256,
  parseAbi,
  toHex,
} from "viem";
import type { AdminEvidenceEnvironment } from "./admin-environment.ts";
import type { ApiEnvironment } from "./environment.ts";

const marketConfig = (packet: CreationEvidencePacket) => ({
  baseStep: BigInt(packet.config.baseStep),
  baseToken: packet.config.baseToken,
  maxMarketOpenNotional: BigInt(packet.config.maxMarketOpenNotional),
  maxOrderNotional: BigInt(packet.config.maxOrderNotional),
  maxOrderQuantity: BigInt(packet.config.maxOrderQuantity),
  maxWalletOpenNotional: BigInt(packet.config.maxWalletOpenNotional),
  metadataHash: packet.config.metadataHash,
  minNotional: BigInt(packet.config.minNotional),
  polymarketConditionId: packet.config.polymarketConditionId,
  polymarketNoIndex: BigInt(packet.config.polymarketNoIndex),
  polymarketYesIndex: BigInt(packet.config.polymarketYesIndex),
  priceTickRawX18: BigInt(packet.config.priceTickRawX18),
  quoteToken: packet.config.quoteToken,
  rulesHash: packet.config.rulesHash,
  tradingCutoff: BigInt(packet.config.tradingCutoff),
  tradingOpen: BigInt(packet.config.tradingOpen),
});

export class AdminEvidenceChain {
  readonly #public;

  constructor(
    readonly apiEnvironment: ApiEnvironment,
    readonly adminEnvironment: AdminEvidenceEnvironment,
  ) {
    this.#public = createPublicClient({ transport: http(apiEnvironment.rpcUrl, { batch: true }) });
  }

  async assertNetwork(): Promise<void> {
    const version = await this.#public.readContract({
      abi: marketRegistryAbi,
      address: this.apiEnvironment.marketRegistry,
      functionName: "PROTOCOL_VERSION",
    });
    if (version !== 2) throw new Error("Admin API requires a v2 raw-unit ratio registry");
    const actual = await this.#public.getChainId();
    if (actual !== this.apiEnvironment.chainId) {
      throw new Error(
        `admin chain mismatch: expected ${this.apiEnvironment.chainId}, got ${actual}`,
      );
    }
    await this.#assertRole("MARKET_ADMIN_ROLE");
  }

  async #assertRole(role: "MARKET_ADMIN_ROLE" | "RESOLUTION_ADMIN_ROLE") {
    const authority = await this.#public.readContract({
      abi: marketRegistryAbi,
      address: this.apiEnvironment.marketRegistry,
      functionName: "authority",
    });
    const allowed = await this.#public.readContract({
      abi: parseAbi(["function hasRole(bytes32 role, address account) view returns (bool)"]),
      address: authority,
      functionName: "hasRole",
      args: [keccak256(toHex(role)), this.adminEnvironment.marketAdmin],
    });
    if (!allowed)
      throw new Error(
        `Configured MARKET_ADMIN needs ${role} on the deployed ProtocolAuthority. The protocol owner must grant it before this action.`,
      );
  }

  async creationPreview(
    envelope: EvidenceEnvelope<CreationEvidencePacket>,
  ): Promise<AdminTransactionPreview> {
    await this.#assertRole("MARKET_ADMIN_ROLE");
    const config = marketConfig(envelope.packet);
    const blockNumber = (await this.#public.getBlock()).number;
    const [baseTokenDecimals, quoteTokenDecimals, protocolVersion] = await Promise.all([
      this.#public.readContract({
        abi: erc20Abi,
        address: config.baseToken,
        functionName: "decimals",
        blockNumber,
      }),
      this.#public.readContract({
        abi: erc20Abi,
        address: config.quoteToken,
        functionName: "decimals",
        blockNumber,
      }),
      this.#public.readContract({
        abi: marketRegistryAbi,
        address: this.apiEnvironment.marketRegistry,
        functionName: "PROTOCOL_VERSION",
        blockNumber,
      }),
    ]);
    const units = {
      baseTokenDecimals,
      quoteTokenDecimals,
      protocolVersion,
      priceFormat: PRICE_FORMAT,
    };
    assertMarketUnits(units);
    const expectedMarketId = (await this.#public.readContract({
      abi: marketRegistryAbi,
      address: this.apiEnvironment.marketRegistry,
      args: [config],
      functionName: "computeMarketId",
    } as never)) as Hex;
    await this.#public.simulateContract({
      abi: marketRegistryAbi,
      account: this.adminEnvironment.marketAdmin,
      address: this.apiEnvironment.marketRegistry,
      args: [config, envelope.packet.config.metadataUri],
      functionName: "createMarket",
    } as never);
    return {
      ...this.#preview(
        "create-market",
        this.adminEnvironment.marketAdmin,
        this.apiEnvironment.marketRegistry,
        encodeFunctionData({
          abi: marketRegistryAbi,
          args: [config, envelope.packet.config.metadataUri],
          functionName: "createMarket",
        }),
        expectedMarketId,
        envelope.packetHash,
      ),
      units,
    };
  }

  async beginResolutionPreview(
    envelope: EvidenceEnvelope<ResolutionEvidencePacket>,
  ): Promise<AdminTransactionPreview> {
    await this.#assertRole("MARKET_ADMIN_ROLE");
    const marketId = envelope.packet.localMarket.marketId;
    const commitment = hashResolutionCommitment({
      chainId: BigInt(this.apiEnvironment.chainId),
      controller: this.adminEnvironment.resolutionController,
      marketId,
      yesPayout: BigInt(envelope.packet.payout.yes),
      noPayout: BigInt(envelope.packet.payout.no),
      payoutDenominator: BigInt(envelope.packet.payout.denominator),
      evidenceHash: envelope.packetHash,
      evidenceUri: envelope.packet.sourceReference,
    });
    await this.#public.simulateContract({
      abi: marketRegistryAbi,
      account: this.adminEnvironment.marketAdmin,
      address: this.apiEnvironment.marketRegistry,
      args: [marketId, commitment],
      functionName: "beginResolution",
    } as never);
    return this.#preview(
      "begin-resolution",
      this.adminEnvironment.marketAdmin,
      this.apiEnvironment.marketRegistry,
      encodeFunctionData({
        abi: marketRegistryAbi,
        args: [marketId, commitment],
        functionName: "beginResolution",
      }),
      marketId,
      envelope.packetHash,
    );
  }

  async resolutionPreview(
    envelope: EvidenceEnvelope<ResolutionEvidencePacket>,
  ): Promise<AdminTransactionPreview> {
    await this.#assertRole("RESOLUTION_ADMIN_ROLE");
    const packet = envelope.packet;
    const args = [
      packet.localMarket.marketId,
      BigInt(packet.payout.yes),
      BigInt(packet.payout.no),
      BigInt(packet.payout.denominator),
      envelope.packetHash,
      packet.sourceReference,
    ] as const;
    await this.#public.simulateContract({
      abi: manualResolutionControllerAbi,
      account: this.adminEnvironment.marketAdmin,
      address: this.adminEnvironment.resolutionController,
      args,
      functionName: "resolveMarket",
    } as never);
    return this.#preview(
      "resolve-market",
      this.adminEnvironment.marketAdmin,
      this.adminEnvironment.resolutionController,
      encodeFunctionData({
        abi: manualResolutionControllerAbi,
        args,
        functionName: "resolveMarket",
      }),
      packet.localMarket.marketId,
      envelope.packetHash,
    );
  }

  async assertTransactionMatches(
    preview: AdminTransactionPreview,
    transactionHash: Hex,
  ): Promise<void> {
    const transaction = await this.#public.getTransaction({ hash: transactionHash });
    const matches =
      transaction.chainId === preview.chainId &&
      getAddress(transaction.from) === getAddress(preview.from) &&
      transaction.to !== null &&
      getAddress(transaction.to) === getAddress(preview.to) &&
      transaction.value.toString() === preview.value &&
      transaction.input.toLowerCase() === preview.data.toLowerCase();
    if (!matches) {
      throw new Error("canonical transaction does not match the approved admin preview");
    }
  }

  #preview(
    action: AdminAction,
    from: Address,
    to: Address,
    data: Hex,
    expectedMarketId: Hex,
    packetHash: Hex,
  ): AdminTransactionPreview {
    return {
      action,
      chainId: this.apiEnvironment.chainId,
      data,
      expectedMarketId,
      from,
      packetHash,
      previewId: crypto.randomUUID(),
      to,
      value: "0",
    };
  }
}
