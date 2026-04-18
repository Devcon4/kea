import { serve } from "@hono/node-server";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase } from "./db/connection.js";
import { createRoutes } from "./app.js";
import { createLogger } from "./logger.js";

const log = createLogger("main");

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://kea:kea@localhost:5432/kea";
const port = Number(process.env.PORT) || 4000;

const { db, client } = createDatabase(databaseUrl);

// Apply pending migrations before starting the server
await migrate(db, { migrationsFolder: "drizzle" });
log.info("database migrations applied");

const app = createRoutes(db);

serve({ fetch: app.fetch, port }, () => {
  log.info({ port }, "kea api started");
});

// Graceful shutdown
const shutdown = async () => {
  log.info("shutting down");
  await client.end();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
