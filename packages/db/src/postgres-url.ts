export function databaseUrl(value: string | undefined): string {
  if (!value) throw new Error("DATABASE_URL is required; no local database fallback is supported");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a PostgreSQL URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    url.pathname.length < 2
  )
    throw new Error("DATABASE_URL must identify a PostgreSQL server and database");
  return value;
}
