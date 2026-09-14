import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  // OpenNext expects .next; Next 16 preserves the separate .next/dev directory.
  distDir: process.env.PROBABL_REHEARSAL_BUILD === "1" ? ".next-rehearsal" : ".next",
  reactStrictMode: true,
  transpilePackages: ["@conditional-stocks/domain"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
