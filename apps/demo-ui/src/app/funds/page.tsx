import type { Metadata } from "next";
import { FundsPageModule } from "@/modules/FundsPageModule";
export const metadata: Metadata = { title: "Funds" };
export default function FundsPage() {
  return <FundsPageModule />;
}
