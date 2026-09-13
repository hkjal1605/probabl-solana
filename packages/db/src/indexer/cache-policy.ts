export function isolatedCacheSchema(schema: string): string {
  if (
    !/^[a-z_][a-z0-9_]{0,44}$/.test(schema) ||
    /^(cs_sync_|pg_|ponder_sync(?:_|$))/.test(schema) ||
    [
      "information_schema",
      "public",
      "probabl",
      "probabl_migrations",
      "gateway",
      "matching",
      "settlement",
      "operations",
    ].includes(schema)
  )
    throw new Error("DATABASE_SCHEMA must be a lowercase SQL identifier of at most 45 characters");
  return `cs_sync_${schema}`;
}
