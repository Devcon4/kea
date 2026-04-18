import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Database = PostgresJsDatabase<typeof schema>;

export function createDatabase(connectionString: string): {
  db: Database;
  client: postgres.Sql;
} {
  const client = postgres(connectionString);
  const db = drizzle(client, { schema });
  return { db, client };
}
