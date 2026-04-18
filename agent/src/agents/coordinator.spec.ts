import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHandler, agentCard, parsePlan, buildFallbackPlan } from "./coordinator.js";
import type { AgentDeps, CoordinatorPlan } from "./coordinator.js";
import { Ok, Err } from "../result.js";
import type { Task, Message } from "../a2a/types.js";
import type { DataStore, SitemapEntry, SitemapStats } from "../memory/data-store.js";

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock("../llm/client.js", () => ({
  chat: vi.fn(),
}));

import { chat } from "../llm/client.js";
const mockChat = vi.mocked(chat);

function createMockStore(): DataStore {
  return {
    getSitemapStats: vi.fn().mockResolvedValue(
      Ok({ total: 5, discovered: 3, visited: 1, tested: 1 }),
    ),
    getUnvisitedPages: vi.fn().mockResolvedValue(
      Ok([
        { url: "https://example.com/page1", title: "", links: [], status: "discovered", discoveredAt: 1, visitedAt: null },
        { url: "https://example.com/page2", title: "", links: [], status: "discovered", discoveredAt: 2, visitedAt: null },
      ]),
    ),
    getUntestedPages: vi.fn().mockResolvedValue(
      Ok([
        { url: "https://example.com/visited1", title: "Visited", links: [], status: "visited", discoveredAt: 1, visitedAt: 100 },
      ]),
    ),
    addMessage: vi.fn().mockResolvedValue(Ok(1)),
  } as unknown as DataStore;
}

function createTask(): Task {
  return {
    id: "task-1",
    contextId: "ctx-1",
    status: { state: "TASK_STATE_WORKING", timestamp: new Date().toISOString() },
    history: [],
  };
}

function createMessage(text: string): Message {
  return {
    messageId: "msg-1",
    role: "ROLE_USER",
    parts: [{ text }],
  };
}

describe("coordinator agentCard", () => {
  it("has correct name", () => {
    expect(agentCard.name).toBe("coordinator");
  });

  it("has skills defined", () => {
    expect(agentCard.skills.length).toBeGreaterThan(0);
  });

  it("has version", () => {
    expect(agentCard.version).toBe("0.2.0");
  });
});

describe("parsePlan", () => {
  it("parses a valid multi-command plan", () => {
    const text = JSON.stringify({
      commands: [
        { type: "navigate", url: "https://example.com/a" },
        { type: "test", url: "https://example.com/b" },
        { type: "test", url: "https://example.com/c" },
      ],
    });
    const plan = parsePlan(text);
    expect(plan.commands).toHaveLength(3);
    expect(plan.commands[0]).toEqual({ type: "navigate", url: "https://example.com/a" });
    expect(plan.commands[1].type).toBe("test");
  });

  it("parses invalidate and remove commands", () => {
    const text = JSON.stringify({
      commands: [
        { type: "invalidate", url: "https://example.com/stale" },
        { type: "remove", url: "https://example.com/dead" },
      ],
    });
    const plan = parsePlan(text);
    expect(plan.commands).toHaveLength(2);
    expect(plan.commands[0]).toEqual({ type: "invalidate", url: "https://example.com/stale" });
    expect(plan.commands[1]).toEqual({ type: "remove", url: "https://example.com/dead" });
  });

  it("parses done command", () => {
    const text = JSON.stringify({
      commands: [{ type: "done", reason: "all tested" }],
    });
    const plan = parsePlan(text);
    expect(plan.commands).toEqual([{ type: "done", reason: "all tested" }]);
  });

  it("strips markdown code fences", () => {
    const text = '```json\n{"commands":[{"type":"done","reason":"finished"}]}\n```';
    const plan = parsePlan(text);
    expect(plan.commands[0].type).toBe("done");
  });

  it("returns done for non-JSON response", () => {
    const plan = parsePlan("I think we should navigate to the about page");
    expect(plan.commands[0].type).toBe("done");
  });

  it("returns done for empty commands array", () => {
    const plan = parsePlan(JSON.stringify({ commands: [] }));
    expect(plan.commands[0].type).toBe("done");
  });

  it("filters out invalid commands but keeps valid ones", () => {
    const text = JSON.stringify({
      commands: [
        { type: "navigate", url: "https://example.com/a" },
        { type: "bogus", url: "https://example.com/b" },
        { type: "test" }, // missing url
        { type: "test", url: "https://example.com/c" },
      ],
    });
    const plan = parsePlan(text);
    expect(plan.commands).toHaveLength(2);
    expect(plan.commands[0].type).toBe("navigate");
    expect(plan.commands[1].type).toBe("test");
  });
});

describe("buildFallbackPlan", () => {
  const entry = (url: string, status: string): any => ({
    url, title: "", links: [], status, discoveredAt: 1, visitedAt: status === "visited" ? 100 : null,
  });

  it("includes 1 navigate + up to 3 tests", () => {
    const stats: SitemapStats = { total: 6, discovered: 2, visited: 3, tested: 1 };
    const unvisited = [entry("https://a.com", "discovered"), entry("https://b.com", "discovered")];
    const untested = [entry("https://c.com", "visited"), entry("https://d.com", "visited"), entry("https://e.com", "visited"), entry("https://f.com", "visited")];

    const plan = buildFallbackPlan(stats, unvisited, untested);
    expect(plan.commands.filter((c) => c.type === "navigate")).toHaveLength(1);
    expect(plan.commands.filter((c) => c.type === "test")).toHaveLength(3);
  });

  it("returns done when nothing to do", () => {
    const plan = buildFallbackPlan({ total: 5, discovered: 0, visited: 0, tested: 5 }, [], []);
    expect(plan.commands).toEqual([{ type: "done", reason: "all pages visited and tested" }]);
  });

  it("returns only tests when no unvisited pages", () => {
    const plan = buildFallbackPlan(
      { total: 3, discovered: 0, visited: 2, tested: 1 },
      [],
      [entry("https://a.com", "visited")],
    );
    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0].type).toBe("test");
  });
});

describe("coordinator createHandler", () => {
  let store: DataStore;
  let handler: ReturnType<typeof createHandler>;

  beforeEach(() => {
    mockChat.mockReset();
    store = createMockStore();
    handler = createHandler({ store });
  });

  it("returns a function", () => {
    expect(typeof handler).toBe("function");
  });

  it("queries store for stats, unvisited, and untested pages", async () => {
    mockChat.mockResolvedValueOnce(
      Ok({
        id: "c1",
        object: "chat.completion",
        created: 1,
        model: "test",
        choices: [{ index: 0, message: { role: "assistant", content: '{"commands":[{"type":"navigate","url":"https://example.com/page1"}]}' }, finish_reason: "stop", logprobs: null }],
      } as any),
    );

    await handler(createTask(), createMessage("what next?"));

    expect(store.getSitemapStats).toHaveBeenCalledOnce();
    expect(store.getUnvisitedPages).toHaveBeenCalledWith(10);
    expect(store.getUntestedPages).toHaveBeenCalledWith(10);
  });

  it("returns Ok with completed state on success", async () => {
    mockChat.mockResolvedValueOnce(
      Ok({
        id: "c1",
        object: "chat.completion",
        created: 1,
        model: "test",
        choices: [{ index: 0, message: { role: "assistant", content: '{"commands":[{"type":"navigate","url":"https://example.com"}]}' }, finish_reason: "stop", logprobs: null }],
      } as any),
    );

    const result = await handler(createTask(), createMessage("plan"));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.state).toBe("TASK_STATE_COMPLETED");
      expect(result.value.response[0].text).toContain("navigate");
    }
  });

  it("returns Err when getSitemapStats fails", async () => {
    (store.getSitemapStats as any).mockResolvedValue(Err(new Error("db error")));

    const result = await handler(createTask(), createMessage("plan"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("db error");
    }
  });

  it("returns Err when getUnvisitedPages fails", async () => {
    (store.getUnvisitedPages as any).mockResolvedValue(Err(new Error("query error")));

    const result = await handler(createTask(), createMessage("plan"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("query error");
    }
  });

  it("returns Err when getUntestedPages fails", async () => {
    (store.getUntestedPages as any).mockResolvedValue(Err(new Error("untested query error")));

    const result = await handler(createTask(), createMessage("plan"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("untested query error");
    }
  });

  it("returns Err when LLM call fails", async () => {
    mockChat.mockResolvedValueOnce(Err(new Error("LLM timeout")));

    const result = await handler(createTask(), createMessage("plan"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("LLM timeout");
    }
  });

  it("uses default text when message parts are empty", async () => {
    mockChat.mockResolvedValueOnce(
      Ok({
        id: "c1",
        object: "chat.completion",
        created: 1,
        model: "test",
        choices: [{ index: 0, message: { role: "assistant", content: '{"action":"done","target":"","reason":"all visited"}' }, finish_reason: "stop", logprobs: null }],
      } as any),
    );

    const emptyMsg: Message = {
      messageId: "msg-1",
      role: "ROLE_USER",
      parts: [],
    };

    const result = await handler(createTask(), emptyMsg);
    expect(result.ok).toBe(true);

    // Verify chat was called with the default "What should we do next?" text
    const chatCall = mockChat.mock.calls[0][0];
    const userContent = chatCall.messages[1].content as string;
    expect(userContent).toContain("What should we do next?");
  });
});
