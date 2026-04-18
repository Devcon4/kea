import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { createApp } from "./http.js";
import { Ok, Err } from "../result.js";
import type { DataStore } from "../memory/data-store.js";
import type { A2AServer } from "../a2a/server.js";

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

function createMockStore() {
  return {
    getSitemapStats: vi.fn().mockResolvedValue(
      Ok({ total: 10, discovered: 5, visited: 3, tested: 2 }),
    ),
    getFindingsStats: vi.fn().mockResolvedValue(
      Ok({ info: 3, warning: 2, error: 1, critical: 0 }),
    ),
    getAllPages: vi.fn().mockResolvedValue(
      Ok([
        { url: "https://example.com", title: "Home", links: [], status: "visited", discoveredAt: 1000, visitedAt: 2000 },
      ]),
    ),
    getFindings: vi.fn().mockResolvedValue(
      Ok([
        { id: 1, url: "https://example.com", agentId: "tester", action: "click", result: "404", severity: "error", timestamp: 3000 },
      ]),
    ),
    close: vi.fn(),
  } as unknown as DataStore;
}

function createMockAgent(name: string) {
  return {
    card: { name },
    getAgentCard: vi.fn().mockReturnValue({ name, version: "0.1.0" }),
    listTasks: vi.fn().mockReturnValue([
      { id: `task-${name}`, status: { state: "TASK_STATE_COMPLETED" } },
    ]),
  } as unknown as A2AServer;
}

async function request(app: Hono, path: string, query?: string): Promise<Response> {
  const url = `http://localhost${path}${query ? `?${query}` : ""}`;
  return app.request(url);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(res: Response): Promise<any> {
  return res.json();
}

describe("createApp", () => {
  let store: ReturnType<typeof createMockStore>;
  let agents: A2AServer[];
  let app: Hono;

  beforeEach(() => {
    store = createMockStore();
    agents = [createMockAgent("coordinator"), createMockAgent("navigator")];
    app = createApp({ store: store as unknown as DataStore, agents });
  });

  describe("GET /healthz", () => {
    it("returns ok and timestamp", async () => {
      const res = await request(app, "/healthz");
      expect(res.status).toBe(200);

      const body = await json(res);
      expect(body.ok).toBe(true);
      expect(body.timestamp).toBeTypeOf("string");
    });
  });

  describe("GET /readyz", () => {
    it("returns ready and timestamp", async () => {
      const res = await request(app, "/readyz");
      expect(res.status).toBe(200);

      const body = await json(res);
      expect(body.ready).toBe(true);
      expect(body.timestamp).toBeTypeOf("string");
    });
  });

  describe("GET /.well-known/agent-cards", () => {
    it("returns all agent cards", async () => {
      const res = await request(app, "/.well-known/agent-cards");
      expect(res.status).toBe(200);

      const body = await json(res);
      expect(body).toHaveLength(2);
      expect(body[0].name).toBe("coordinator");
      expect(body[1].name).toBe("navigator");
    });
  });

  describe("GET /api/status", () => {
    it("returns sitemap and findings stats", async () => {
      const res = await request(app, "/api/status");
      expect(res.status).toBe(200);

      const body = await json(res);
      expect(body.sitemap).toEqual({ total: 10, discovered: 5, visited: 3, tested: 2 });
      expect(body.findings).toEqual({ info: 3, warning: 2, error: 1, critical: 0 });
    });

    it("returns 500 when getSitemapStats fails", async () => {
      (store.getSitemapStats as any).mockResolvedValue(Err(new Error("db error")));

      const res = await request(app, "/api/status");
      expect(res.status).toBe(500);

      const body = await json(res);
      expect(body.error).toBe("db error");
    });

    it("returns 500 when getFindingsStats fails", async () => {
      (store.getFindingsStats as any).mockResolvedValue(Err(new Error("findings error")));

      const res = await request(app, "/api/status");
      expect(res.status).toBe(500);

      const body = await json(res);
      expect(body.error).toBe("findings error");
    });
  });

  describe("GET /api/sitemap", () => {
    it("returns all pages", async () => {
      const res = await request(app, "/api/sitemap");
      expect(res.status).toBe(200);

      const body = await json(res);
      expect(body).toHaveLength(1);
      expect(body[0].url).toBe("https://example.com");
    });

    it("returns 500 when getAllPages fails", async () => {
      (store.getAllPages as any).mockResolvedValue(Err(new Error("pages error")));

      const res = await request(app, "/api/sitemap");
      expect(res.status).toBe(500);

      const body = await json(res);
      expect(body.error).toBe("pages error");
    });
  });

  describe("GET /api/findings", () => {
    it("returns all findings without url filter", async () => {
      const res = await request(app, "/api/findings");
      expect(res.status).toBe(200);

      const body = await json(res);
      expect(body).toHaveLength(1);
      expect(body[0].severity).toBe("error");
    });

    it("passes url query param to store", async () => {
      await request(app, "/api/findings", "url=https://example.com");

      expect(store.getFindings).toHaveBeenCalledWith("https://example.com");
    });

    it("calls getFindings without url when no query param", async () => {
      await request(app, "/api/findings");

      expect(store.getFindings).toHaveBeenCalledWith(undefined);
    });

    it("returns 500 when getFindings fails", async () => {
      (store.getFindings as any).mockResolvedValue(Err(new Error("findings error")));

      const res = await request(app, "/api/findings");
      expect(res.status).toBe(500);

      const body = await json(res);
      expect(body.error).toBe("findings error");
    });
  });

  describe("GET /api/tasks", () => {
    it("returns tasks from all agents", async () => {
      const res = await request(app, "/api/tasks");
      expect(res.status).toBe(200);

      const body = await json(res);
      expect(body).toHaveLength(2);
      expect(body[0].id).toBe("task-coordinator");
      expect(body[1].id).toBe("task-navigator");
    });

    it("calls listTasks on each agent", async () => {
      await request(app, "/api/tasks");

      for (const agent of agents) {
        expect(agent.listTasks).toHaveBeenCalled();
      }
    });
  });
});
