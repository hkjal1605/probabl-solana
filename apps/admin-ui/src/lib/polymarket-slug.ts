export function parseMarketSlug(input: unknown): string {
  const slug = typeof input === "string" ? input.trim() : "";
  if (!/^[a-z0-9][a-z0-9-]{0,511}$/.test(slug)) {
    throw new Error(
      "Enter the Polymarket market slug, for example clarity-act-signed-into-law-in-2026 (not a full URL).",
    );
  }
  return slug;
}
