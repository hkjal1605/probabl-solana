import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  distDir: process.env.PROBABL_REHEARSAL_BUILD === "1" ? ".next-rehearsal" : ".next",
  reactStrictMode: true,
  // Explicit public address aliases only. Never expose private keys or service credentials.
  env: {
    NEXT_PUBLIC_RESOLUTION_CONTROLLER_ADDRESS:
      process.env.NEXT_PUBLIC_RESOLUTION_CONTROLLER_ADDRESS ??
      process.env.RESOLUTION_CONTROLLER_ADDRESS ??
      "",
    NEXT_PUBLIC_MARKET_ADMIN_ADDRESS:
      process.env.NEXT_PUBLIC_MARKET_ADMIN_ADDRESS ?? process.env.MARKET_ADMIN ?? "",
  },
  transpilePackages: [
    "@conditional-stocks/domain",
    "@conditional-stocks/market-data",
    "@conditional-stocks/contract-bindings",
    "@conditional-stocks/ui-kit",
  ],
  poweredByHeader: false,
};
export default nextConfig;
