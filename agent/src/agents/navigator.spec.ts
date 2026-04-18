import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHandler, agentCard } from "./navigator.js";
import { Ok, Err } from "../result.js";
import type { Task, Message } from "../a2a/types.js";
import type { DataStore } from "../memory/data-store.js";

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

function createMockStore() {
  return {
    upsertPage: vi.fn().mockResolvedValue(Ok(undefined)),
    discoverPage: vi.fn().mockResolvedValue(Ok(undefined)),
    getSitemapStats: vi.fn().mockResolvedValue(Ok({ total: 0, discovered: 0, visited: 0, tested: 0 })),
    getUnvisitedPages: vi.fn().mockResolvedValue(Ok([])),
    getPage: vi.fn().mockResolvedValue(Ok(null)),
    getAllPages: vi.fn().mockResolvedValue(Ok([])),
    addFinding: vi.fn().mockResolvedValue(Ok(1)),
    getFindings: vi.fn().mockResolvedValue(Ok([])),
    getFindingsStats: vi.fn().mockResolvedValue(Ok({ info: 0, warning: 0, error: 0, critical: 0 })),
    close: vi.fn(),
  } as unknown as DataStore;
}

function createTask(): Task {
  return {
    id: "task-1",
    contextId: "ctx-1",
    status: { state: "TASK_STATE_WORKING" },
    history: [],
  };
}

function createMessage(text: string): Message {
  return { messageId: "msg-1", role: "ROLE_USER", parts: [{ text }] };
}

function mockLLMResponse(content: string) {
  mockChat.mockResolvedValueOnce(
    Ok({
      id: "c1",
      object: "chat.completion",
      created: 1,
      model: "test",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop", logprobs: null }],
    } as any),
  );
}

describe("navigator agentCard", () => {
  it("has correct name", () => {
    expect(agentCard.name).toBe("navigator");
  });

  it("has skills", () => {
    expect(agentCard.skills.length).toBeGreaterThan(0);
  });
});

describe("navigator createHandler", () => {
  let store: ReturnType<typeof createMockStore>;
  let handler: ReturnType<typeof createHandler>;

  beforeEach(() => {
    mockChat.mockReset();
    store = createMockStore();
    handler = createHandler({ store } as any);
  });

  it("returns Err for empty message", async () => {
    const emptyMsg: Message = { messageId: "m1", role: "ROLE_USER", parts: [] };
    const result = await handler(createTask(), emptyMsg);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("no page content");
    }
  });

  it("processes page content and upserts to store", async () => {
    mockLLMResponse(JSON.stringify({
      title: "About Page",
      links: ["https://example.com/contact"],
      summary: "About us page",
    }));

    const result = await handler(
      createTask(),
      createMessage("URL: https://example.com/about\nTitle: About\n\nSome content"),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.state).toBe("TASK_STATE_COMPLETED");
    }

    expect(store.upsertPage).toHaveBeenCalled();

    // Should upsert the main page as visited
    const mainCall = (store.upsertPage as any).mock.calls[0][0];
    expect(mainCall.status).toBe("visited");
    expect(mainCall.visitedAt).toBeTypeOf("number");
  });

  it("discovers linked pages via discoverPage", async () => {
    mockLLMResponse(JSON.stringify({
      title: "Home",
      links: ["https://example.com/page1", "https://example.com/page2"],
      summary: "Homepage",
    }));

    await handler(
      createTask(),
      createMessage("URL: https://example.com\nTitle: Home\n\nWelcome"),
    );

    // Main page upserted as visited
    expect(store.upsertPage).toHaveBeenCalledTimes(1);

    // Child links discovered via discoverPage (insert-or-ignore)
    expect(store.discoverPage).toHaveBeenCalledTimes(2);
    expect(store.discoverPage).toHaveBeenCalledWith("https://example.com/page1");
    expect(store.discoverPage).toHaveBeenCalledWith("https://example.com/page2");
  });

  it("handles non-JSON LLM response gracefully", async () => {
    mockLLMResponse("I couldn't understand the page format");

    const result = await handler(
      createTask(),
      createMessage("URL: https://example.com/weird\n\nSome content"),
    );

    // Should still succeed — parseLLMResponse returns {} on parse failure
    expect(result.ok).toBe(true);
    // Should still upsert the page with extracted URL
    expect(store.upsertPage).toHaveBeenCalled();
  });

  it("extracts URL from message text when LLM response has no url", async () => {
    mockLLMResponse(JSON.stringify({ title: "Page", links: [] }));

    await handler(
      createTask(),
      createMessage("URL: https://example.com/extracted\n\nContent"),
    );

    const upsertCall = (store.upsertPage as any).mock.calls[0][0];
    expect(upsertCall.url).toBe("https://example.com/extracted");
  });

  it("returns Err when LLM call fails", async () => {
    mockChat.mockResolvedValueOnce(Err(new Error("LLM down")));

    const result = await handler(createTask(), createMessage("URL: https://example.com\n\nContent"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("LLM down");
    }
  });

  it("returns Err when store upsert fails", async () => {
    mockLLMResponse(JSON.stringify({ title: "Page", links: [] }));
    (store.upsertPage as any).mockResolvedValue(Err(new Error("db write error")));

    const result = await handler(
      createTask(),
      createMessage("URL: https://example.com\n\nContent"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("db write error");
    }
  });
});
