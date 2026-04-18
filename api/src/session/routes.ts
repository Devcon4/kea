/**
 * Session Routes — HTTP orchestration layer.
 *
 * Each handler follows the same DDD pattern:
 *   1. Validate input (zod schemas)
 *   2. Load the aggregate root from the repository
 *   3. Call a pure domain function to enforce business rules
 *   4. Persist the result through the repository
 *
 * No business logic lives here — it's all in domain.ts.
 */

import { Hono } from "hono";
import {
  CreateSessionSchema,
  UpdateSessionSchema,
  UpsertPageSchema,
  VisitPageSchema,
  DiscoverPageSchema,
  CreateFindingSchema,
  CreateChatMessageSchema,
} from "@kea/shared";
import type { SessionRepository } from "./repository.js";
import {
  createSession,
  completeSession,
  failSession,
  addFinding,
  addMessage,
  visitPage,
  discoverPage,
  upsertPage,
} from "./domain.js";

export function createSessionRoutes(repo: SessionRepository): Hono {
  const app = new Hono();

  // ── Session lifecycle ────────────────────────────────

  app.get("/api/sessions", async (c) => {
    const rows = await repo.list();
    return c.json(rows);
  });

  app.get("/api/sessions/:id", async (c) => {
    const row = await repo.getById(c.req.param("id"));
    if (!row) return c.json({ error: "session not found" }, 404);
    return c.json(row);
  });

  app.post("/api/sessions", async (c) => {
    const body = CreateSessionSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues }, 400);

    // Domain: factory validates and creates aggregate root
    const result = createSession(body.data);
    if (!result.ok) return c.json({ error: result.error }, 422);

    const saved = await repo.save(result.value);
    return c.json(saved, 201);
  });

  app.patch("/api/sessions/:id", async (c) => {
    const body = UpdateSessionSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues }, 400);

    // Load aggregate
    const session = await repo.getById(c.req.param("id"));
    if (!session) return c.json({ error: "session not found" }, 404);

    // Domain: transition state through domain functions
    if (body.data.status === "completed") {
      const result = completeSession(session, body.data.completedAt ?? undefined);
      if (!result.ok) return c.json({ error: result.error }, 422);
      const saved = await repo.save(result.value);
      return c.json(saved);
    }

    if (body.data.status === "failed") {
      const result = failSession(session, body.data.completedAt ?? undefined);
      if (!result.ok) return c.json({ error: result.error }, 422);
      const saved = await repo.save(result.value);
      return c.json(saved);
    }

    // No status change — just persist updated fields
    const updated = { ...session, ...body.data };
    const saved = await repo.save(updated);
    return c.json(saved);
  });

  app.get("/api/sessions/:id/stats", async (c) => {
    const stats = await repo.getStats(c.req.param("id"));
    return c.json(stats);
  });

  // ── Sitemap (owned entity, through aggregate) ────────

  app.get("/api/sessions/:id/sitemap", async (c) => {
    const sessionId = c.req.param("id");
    const status = c.req.query("status");
    const limit = Number(c.req.query("limit")) || undefined;
    const entries = await repo.listPages(sessionId, { status, limit });
    return c.json(entries);
  });

  app.put("/api/sessions/:id/sitemap", async (c) => {
    const body = UpsertPageSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues }, 400);

    // Load aggregate root to enforce invariants
    const session = await repo.getById(c.req.param("id"));
    if (!session) return c.json({ error: "session not found" }, 404);

    // Domain: validate through aggregate
    const result = upsertPage(session, body.data);
    if (!result.ok) return c.json({ error: result.error }, 422);

    await repo.savePage(session.id, result.value);
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/sitemap/visit", async (c) => {
    const body = VisitPageSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues }, 400);

    const session = await repo.getById(c.req.param("id"));
    if (!session) return c.json({ error: "session not found" }, 404);

    const result = visitPage(session, body.data);
    if (!result.ok) return c.json({ error: result.error }, 422);

    await repo.savePageVisit(session.id, result.value);
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/sitemap/discover", async (c) => {
    const body = DiscoverPageSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues }, 400);

    const session = await repo.getById(c.req.param("id"));
    if (!session) return c.json({ error: "session not found" }, 404);

    const result = discoverPage(session, body.data.url);
    if (!result.ok) return c.json({ error: result.error }, 422);

    await repo.savePageDiscovery(session.id, result.value);
    return c.json({ ok: true });
  });

  app.delete("/api/sessions/:id/sitemap", async (c) => {
    const url = c.req.query("url");
    if (!url) return c.json({ error: "url query param required" }, 400);
    await repo.removePage(c.req.param("id"), url);
    return c.json({ ok: true });
  });

  // ── Findings (owned entity, through aggregate) ───────

  app.get("/api/sessions/:id/findings", async (c) => {
    const sessionId = c.req.param("id");
    const url = c.req.query("url");
    const rows = await repo.listFindings(sessionId, url);
    return c.json(rows);
  });

  app.post("/api/sessions/:id/findings", async (c) => {
    const body = CreateFindingSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues }, 400);

    // Load aggregate root to enforce invariants
    const session = await repo.getById(c.req.param("id"));
    if (!session) return c.json({ error: "session not found" }, 404);

    // Domain: validate through aggregate
    const result = addFinding(session, {
      url: body.data.url,
      agentId: body.data.agentId,
      action: body.data.action,
      result: body.data.result,
      severity: body.data.severity,
      timestamp: body.data.timestamp,
    });
    if (!result.ok) return c.json({ error: result.error }, 422);

    const row = await repo.saveFinding(result.value);
    return c.json(row, 201);
  });

  // ── Messages (agent chat log) ────────────────────────

  app.get("/api/sessions/:id/messages", async (c) => {
    const rows = await repo.listMessages(c.req.param("id"));
    return c.json(rows);
  });

  app.get("/api/sessions/:id/messages/stream", async (c) => {
    const sessionId = c.req.param("id");
    const session = await repo.getById(sessionId);
    if (!session) return c.json({ error: "session not found" }, 404);

    return c.body(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          let lastId = 0;

          const interval = setInterval(async () => {
            try {
              const messages = await repo.listMessages(sessionId);
              const newMessages = messages.filter((m) => m.id > lastId);
              for (const msg of newMessages) {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(msg)}\n\n`),
                );
                lastId = msg.id;
              }
            } catch {
              // ignore polling errors
            }
          }, 2000);

          c.req.raw.signal.addEventListener("abort", () => {
            clearInterval(interval);
            controller.close();
          });
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      },
    );
  });

  app.post("/api/sessions/:id/messages", async (c) => {
    const body = CreateChatMessageSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues }, 400);

    const session = await repo.getById(c.req.param("id"));
    if (!session) return c.json({ error: "session not found" }, 404);

    const result = addMessage(session, {
      agentId: body.data.agentId,
      content: body.data.content,
      thinking: body.data.thinking,
      timestamp: body.data.timestamp,
    });
    if (!result.ok) return c.json({ error: result.error }, 422);

    const row = await repo.saveMessage(result.value);
    return c.json(row, 201);
  });

  return app;
}
