import { describe, it, expect, beforeAll } from "vitest";
import { createRoutes } from "./app.js";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import * as schema from "./db/schema.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json();

// These tests require a running PostgreSQL instance.
// Set TEST_DATABASE_URL to run them, otherwise they are skipped.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("API routes (integration)", () => {
  let app: ReturnType<typeof createRoutes>;
  let client: postgres.Sql;

  beforeAll(async () => {
    client = postgres(TEST_DATABASE_URL!);
    const db = drizzle(client, { schema });

    // Clean tables
    await client`TRUNCATE findings, sitemap, sessions CASCADE`;

    app = createRoutes(db);
  });

  // -- Sessions --

  it("GET /healthz should return ok", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
  });

  it("POST /api/sessions should create a session", async () => {
    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "test-session-1",
        targetUrl: "http://example.com",
        maxPages: 50,
        startedAt: Date.now(),
      }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.id).toBe("test-session-1");
  });

  it("GET /api/sessions should list sessions", async () => {
    const res = await app.request("/api/sessions");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  it("PATCH /api/sessions/:id should update a session", async () => {
    const res = await app.request("/api/sessions/test-session-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed", completedAt: Date.now() }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.status).toBe("completed");
  });

  // -- Sitemap --

  it("POST /api/sessions/:id/sitemap/discover should discover a page", async () => {
    // Reset session to running first
    await app.request("/api/sessions/test-session-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "running", completedAt: null }),
    });

    const res = await app.request(
      "/api/sessions/test-session-1/sitemap/discover",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "http://example.com/page1",
        }),
      },
    );
    expect(res.status).toBe(200);
  });

  it("POST /api/sessions/:id/sitemap/visit should visit a page", async () => {
    const res = await app.request(
      "/api/sessions/test-session-1/sitemap/visit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "http://example.com/page1",
          title: "Page 1",
          links: ["http://example.com/page2"],
        }),
      },
    );
    expect(res.status).toBe(200);
  });

  it("GET /api/sessions/:id/sitemap should list pages", async () => {
    const res = await app.request("/api/sessions/test-session-1/sitemap");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body[0].status).toBe("visited");
  });

  // -- Findings --

  it("POST /api/sessions/:id/findings should add a finding", async () => {
    const res = await app.request("/api/sessions/test-session-1/findings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "http://example.com/page1",
        agentId: "tester-1",
        action: "click submit",
        result: "500 Internal Server Error",
        severity: "error",
        timestamp: Date.now(),
      }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.id).toBeDefined();
  });

  it("GET /api/sessions/:id/findings should list findings", async () => {
    const res = await app.request("/api/sessions/test-session-1/findings");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.length).toBe(1);
    expect(body[0].severity).toBe("error");
  });

  // -- Stats --

  it("GET /api/sessions/:id/stats should return aggregated stats", async () => {
    const res = await app.request("/api/sessions/test-session-1/stats");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.sitemap.visited).toBeGreaterThanOrEqual(1);
    expect(body.findings.error).toBe(1);
  });

  // -- Validation --

  it("POST /api/sessions with invalid body should return 400", async () => {
    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invalid: true }),
    });
    expect(res.status).toBe(400);
  });
});
