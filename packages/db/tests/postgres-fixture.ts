import { getTableColumns, SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { Pool, type QueryResult, type QueryResultRow } from "pg";
import * as schema from "../src/indexer/schema.ts";
import { testDatabase } from "../src/testing.ts";

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
type Query = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[],
) => Promise<QueryResult<T>>;

/** Build test DDL from the real schema, including its actual partial/order indexes. */
export async function postgresFixture(options: { cleanup?: "test" | "file" } = {}) {
  const fixture = await postgresClient(options);
  const { client } = fixture;
  const dialect = new PgDialect();
  for (const table of Object.values(schema)) {
    const config = getTableConfig(table);
    await client.exec(
      `CREATE TABLE ${quote(config.name)} (${config.columns
        .map(
          (column) =>
            `${quote(column.name)} ${column.getSQLType()}${column.primary ? " PRIMARY KEY" : ""}${column.notNull ? " NOT NULL" : ""}`,
        )
        .join(", ")})`,
    );
    for (const index of config.indexes) {
      const { name, columns, where } = index.config;
      if (!name) throw new Error("Fixture index must have a name");
      const keys = columns.map((column) => {
        if (column instanceof SQL) return dialect.sqlToQuery(column).sql;
        if (!("name" in column) || !column.name || !column.indexConfig)
          throw new Error("Unsupported fixture index");
        return `${quote(column.name)} ${column.indexConfig.order} NULLS ${column.indexConfig.nulls}`;
      });
      // PostgreSQL index predicates cannot contain table-qualified identifiers.
      const predicate = where
        ? dialect.sqlToQuery(where).sql.replaceAll(`${quote(config.name)}.`, "")
        : null;
      await client.exec(
        `CREATE INDEX ${quote(name)} ON ${quote(config.name)} (${keys.join(", ")})${predicate ? ` WHERE ${predicate}` : ""}`,
      );
    }
  }
  return { client, db: drizzle(fixture.pool, { schema }) };
}

/** SQL test client backed by a real server, with explicit transaction connection pinning. */
export async function postgresClient(
  options: { cleanup?: "test" | "file"; migrate?: boolean } = {},
) {
  const fixture = await testDatabase(options);
  const pool = new Pool({ connectionString: fixture.connectionString, max: 4 });
  fixture.registerClose(() => pool.end());
  const client = {
    query: <T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) =>
      pool.query<T>(text, values),
    exec: (text: string) => pool.query(text),
    async transaction<T>(work: (client: { query: Query }) => Promise<T>): Promise<T> {
      const connection = await pool.connect();
      try {
        await connection.query("BEGIN");
        const result = await work({ query: (text, values) => connection.query(text, values) });
        await connection.query("COMMIT");
        return result;
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
    },
    async close() {
      await fixture.close();
    },
  };
  return { client, pool, database: fixture.database };
}

/** Generic type-correct defaults; each test supplies the values that matter. */
export function fixtureRow<T extends PgTable>(
  table: T,
  overrides: Partial<T["$inferInsert"]> = {},
): T["$inferInsert"] {
  return Object.fromEntries(
    Object.entries(getTableColumns(table)).map(([key, column]) => [
      key,
      key in overrides
        ? (overrides as Record<string, unknown>)[key]
        : !column.notNull
          ? null
          : column.dataType === "bigint"
            ? 0n
            : column.dataType === "number"
              ? 0
              : column.dataType === "boolean"
                ? false
                : "0x11",
    ]),
  ) as T["$inferInsert"];
}
