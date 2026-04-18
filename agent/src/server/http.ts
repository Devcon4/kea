import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createLogger } from "../logger.js";
import type { DataStore } from "../memory/data-store.js";
import type { A2AServer } from "../a2a/server.js";

const log = createLogger("http");

type ServerDeps = {
  store: DataStore;
  agents: A2AServer[];
};

export function createApp(deps: ServerDeps): Hono {
  const app = new Hono();
  const { store, agents } = deps;

  app.get("/healthz", (c) =>
    c.json({ ok: true, timestamp: new Date().toISOString() }),
  );

  app.get("/readyz", (c) =>
    c.json({ ready: true, timestamp: new Date().toISOString() }),
  );

  app.get("/.well-known/agent-cards", (c) =>
    c.json(agents.map((a) => a.getAgentCard())),
  );

  app.get("/api/status", async (c) => {
    const sitemap = await store.getSitemapStats();
    if (!sitemap.ok) {
      return c.json({ error: sitemap.error.message }, 500);
    }

    const findings = await store.getFindingsStats();
    if (!findings.ok) {
      return c.json({ error: findings.error.message }, 500);
    }

    return c.json({ sitemap: sitemap.value, findings: findings.value });
  });

  app.get("/api/sitemap", async (c) => {
    const pages = await store.getAllPages();
    if (!pages.ok) {
      return c.json({ error: pages.error.message }, 500);
    }

    return c.json(pages.value);
  });

  app.get("/api/findings", async (c) => {
    const url = c.req.query("url");
    const findings = await store.getFindings(url);
    if (!findings.ok) {
      return c.json({ error: findings.error.message }, 500);
    }

    return c.json(findings.value);
  });

  app.get("/api/tasks", (c) =>
    c.json(agents.flatMap((a) => a.listTasks())),
  );

  return app;
}

export function startServer(app: Hono, port?: number) {
  const resolvedPort = port ?? (Number(process.env.PORT) || 3000);

  const server = serve({ fetch: app.fetch, port: resolvedPort }, () => {
    log.info({ port: resolvedPort }, "server started");
  });

  return server;
}
