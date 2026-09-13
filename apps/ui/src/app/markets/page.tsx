import type { Metadata } from "next";
import { MarketsPageModule } from "@/modules/MarketsPageModule";
export const metadata: Metadata = { title: "Markets" };
export default function MarketsPage() {
  return <MarketsPageModule />;
}
