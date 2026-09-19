import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { marketCategoryFromSlug } from "@/lib/markets/presentation";
import { MarketsPageModule } from "@/modules/MarketsPageModule";

export const metadata: Metadata = { title: "Markets" };

export default async function MarketCategoryPage({
  params,
}: {
  params: Promise<{ category: string }>;
}) {
  const { category: slug } = await params;
  const category = marketCategoryFromSlug(slug);
  if (!category) notFound();
  return <MarketsPageModule category={category} />;
}
