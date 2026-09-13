import { MarketDataError } from "@conditional-stocks/market-data";
import { type Address, getAddress, isAddress, zeroAddress } from "viem";

export interface AdminEvidenceEnvironment {
  attachmentPublicBaseUrl: string;
  marketAdmin: Address;
  polymarketIngestorToken: string;
  polymarketIngestorUrl: string;
  resolutionController: Address;
}

const address = (value: string | undefined, name: string): Address => {
  if (!value || !isAddress(value) || getAddress(value) === zeroAddress)
    throw new MarketDataError("INVALID_CONFIG", `${name} is invalid`);
  return getAddress(value);
};

export const loadAdminEvidenceEnvironment = (
  environment: NodeJS.ProcessEnv,
): AdminEvidenceEnvironment | null => {
  // The configured market administrator is the sole authenticated API operator.
  // Legacy operator lists and separate Safe addresses do not grant API permissions.
  if (environment.MARKET_ADMIN === undefined || environment.MARKET_ADMIN.trim() === "") return null;
  const marketAdmin = address(environment.MARKET_ADMIN.trim(), "MARKET_ADMIN");
  const ingestorUrl = environment.POLYMARKET_INGESTOR_URL ?? "http://127.0.0.1:42073";
  const parsedIngestorUrl = new URL(ingestorUrl);
  if (parsedIngestorUrl.protocol !== "http:" && parsedIngestorUrl.protocol !== "https:") {
    throw new MarketDataError("INVALID_CONFIG", "POLYMARKET_INGESTOR_URL must be HTTP(S)");
  }
  const publicBaseUrl = environment.ADMIN_EVIDENCE_PUBLIC_BASE_URL;
  if (!publicBaseUrl || new URL(publicBaseUrl).protocol !== "https:") {
    throw new MarketDataError("INVALID_CONFIG", "ADMIN_EVIDENCE_PUBLIC_BASE_URL must be HTTPS");
  }
  const token = environment.POLYMARKET_INTERNAL_TOKEN;
  if (!token || token.length < 16) {
    throw new MarketDataError("INVALID_CONFIG", "POLYMARKET_INTERNAL_TOKEN is required");
  }
  return {
    attachmentPublicBaseUrl: publicBaseUrl.replace(/\/$/, ""),
    marketAdmin,
    polymarketIngestorToken: token,
    polymarketIngestorUrl: parsedIngestorUrl.toString().replace(/\/$/, ""),
    resolutionController: address(
      environment.RESOLUTION_CONTROLLER_ADDRESS,
      "RESOLUTION_CONTROLLER_ADDRESS",
    ),
  };
};
