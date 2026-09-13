/** Experimental mainnet is an explicit risk acceptance, never production approval. */
export const INTERNAL_MAINNET_ACK = "I_ACCEPT_M02_AND_DEPENDENCY_RISK_FOR_INTERNAL_TESTING";

export function releasePolicy(chainId: number, environment: Record<string, string | undefined>) {
  if (chainId === 31337 || chainId === 46630) {
    return { mode: "development" as const, productionApproved: false as const };
  }
  if (
    chainId !== 4663 ||
    environment.DEPLOYMENT_MODE !== "internal-mainnet" ||
    environment.INTERNAL_MAINNET_RISK_ACK !== INTERNAL_MAINNET_ACK
  ) {
    throw new Error(
      "M-02 remains open: mainnet requires explicit internal-mainnet risk acceptance; other networks are unsupported",
    );
  }
  return {
    mode: "internal-mainnet" as const,
    productionApproved: false as const,
    deferredFindings: ["M-02", "R-04"],
    riskAcknowledgement: INTERNAL_MAINNET_ACK,
  };
}
