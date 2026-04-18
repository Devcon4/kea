import { Hono } from "hono";
import type { Database } from "./db/connection.js";
import { createSessionRepository } from "./session/repository.js";
import { createSessionRoutes } from "./session/routes.js";

export function createRoutes(db: Database): Hono {
  const app = new Hono();

  // Health
  app.get("/healthz", (c) =>
    c.json({ ok: true, timestamp: new Date().toISOString() }),
  );
  app.get("/readyz", (c) =>
    c.json({ ready: true, timestamp: new Date().toISOString() }),
  );

  // Session aggregate
  const sessionRepo = createSessionRepository(db);
  app.route("/", createSessionRoutes(sessionRepo));

  return app;
}
