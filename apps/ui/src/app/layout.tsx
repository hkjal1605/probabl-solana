import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@/styles/global.css";
import { SiteFooter } from "@/components/layout/SiteFooter";
import { SiteHeader } from "@/components/layout/SiteHeader";
import { AppProviders } from "@/components/providers/AppProviders";
import { protocolConfig } from "@/config/protocol";

export const metadata: Metadata = {
  title: { default: "probabl — Event-driven stock markets", template: "%s · probabl" },
  applicationName: "probabl",
  description:
    "Trade conditional stock values across clear YES and NO event outcomes with onchain settlement.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "https://probabl.trade"),
  openGraph: {
    siteName: "probabl",
    images: [
      { url: "/og.png", width: 1200, height: 630, alt: "probabl — Event-driven stock markets" },
    ],
  },
  icons: { icon: "/brand/favicon.svg", apple: "/brand/apple-touch-icon.png" },
};
export const dynamic = "force-dynamic";
export const viewport: Viewport = { colorScheme: "light dark" };
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" data-scroll-behavior="smooth" suppressHydrationWarning>
      <body className="flex min-h-dvh flex-col text-sm">
        <AppProviders>
          <SiteHeader />
          {protocolConfig.chainName === "Solana Mainnet" && (
            <div role="note" className="bg-warning-soft px-5 py-2 text-center text-sm text-warning">
              Internal mainnet testing · Real assets at risk · Not approved for public production
            </div>
          )}
          {children}
          <SiteFooter />
        </AppProviders>
      </body>
    </html>
  );
}
