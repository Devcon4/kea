import { Hono } from "hono";
import type { Database } from "./db/connection.js";
import { createEventBus } from "./events/bus.js";
import type { EventBus } from "./events/bus.js";
import { createSessionRepository } from "./session/repository.js";
import { createSessionRoutes } from "./session/routes.js";
import { createFeatureRepository } from "./features/repository.js";
import { createFeatureRoutes } from "./features/routes.js";

export function createRoutes(db: Database, bus: EventBus = createEventBus()): Hono {
  const app = new Hono();

  // Health
  app.get("/healthz", (c) => c.json({ ok: true, timestamp: new Date().toISOString() }));
  app.get("/readyz", (c) => c.json({ ready: true, timestamp: new Date().toISOString() }));

  // Session aggregate
  const sessionRepo = createSessionRepository(db);
  app.route("/", createSessionRoutes(sessionRepo, bus));

  // Feature aggregate
  const featureRepo = createFeatureRepository(db);
  app.route("/", createFeatureRoutes(featureRepo, sessionRepo, bus));

  return app;
}