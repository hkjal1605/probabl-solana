import type { Metadata } from "next";
import { ResolutionPageModule } from "@/modules/ResolutionPageModule";
export const metadata: Metadata = { title: "Resolution center" };
export default async function ResolutionPage({
  searchParams,
}: {
  searchParams: Promise<{ market?: string }>;
}) {
  const { market } = await searchParams;
  return <ResolutionPageModule {...(market ? { selected: market } : {})} />;
}
