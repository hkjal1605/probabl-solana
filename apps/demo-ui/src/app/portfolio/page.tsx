import type { Metadata } from "next";
import { PortfolioPageModule } from "@/modules/PortfolioPageModule";
export const metadata: Metadata = { title: "Portfolio" };
export default function PortfolioPage() {
  return <PortfolioPageModule />;
}
