import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  distDir: process.env.PROBABL_REHEARSAL_BUILD === "1" ? ".next-rehearsal" : ".next",
  reactStrictMode: true,
  transpilePackages: [
    "@conditional-stocks/domain",
    "@conditional-stocks/market-data",
    "@conditional-stocks/contract-bindings",
  ],
  poweredByHeader: false,
};
export default nextConfig;
