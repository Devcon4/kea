import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHandler, agentCard } from "./tester.js";
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
    addFinding: vi.fn().mockResolvedValue(Ok(1)),
    addMessage: vi.fn().mockResolvedValue(Ok(1)),
    upsertPage: vi.fn().mockResolvedValue(Ok(undefined)),
    getSitemapStats: vi.fn().mockResolvedValue(Ok({ total: 0, discovered: 0, visited: 0, tested: 0 })),
    getUnvisitedPages: vi.fn().mockResolvedValue(Ok([])),
    getPage: vi.fn().mockResolvedValue(Ok(null)),
    getAllPages: vi.fn().mockResolvedValue(Ok([])),
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

describe("tester agentCard", () => {
  it("has correct name", () => {
    expect(agentCard.name).toBe("tester");
  });

  it("has skills", () => {
    expect(agentCard.skills.length).toBeGreaterThan(0);
  });
});

describe("tester createHandler", () => {
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

  it("processes page and stores findings", async () => {
    mockLLMResponse(JSON.stringify({
      findings: [
        { action: "check form validation", result: "no client-side validation", severity: "warning" },
        { action: "check 404 handling", result: "server returns 500 instead", severity: "error" },
      ],
    }));

    const result = await handler(
      createTask(),
      createMessage("URL: https://example.com/form\n\nForm content here"),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.state).toBe("TASK_STATE_COMPLETED");
    }

    expect(store.addFinding).toHaveBeenCalledTimes(2);

    const firstCall = (store.addFinding as any).mock.calls[0][0];
    expect(firstCall.url).toBe("https://example.com/form");
    expect(firstCall.agentId).toBe("tester");
    expect(firstCall.action).toBe("check form validation");
    expect(firstCall.severity).toBe("warning");
  });

  it("defaults severity to info for invalid values", async () => {
    mockLLMResponse(JSON.stringify({
      findings: [
        { action: "test", result: "something", severity: "catastrophic" },
      ],
    }));

    await handler(
      createTask(),
      createMessage("URL: https://example.com\n\nContent"),
    );

    const addCall = (store.addFinding as any).mock.calls[0][0];
    expect(addCall.severity).toBe("info");
  });

  it("defaults severity to info when severity is missing", async () => {
    mockLLMResponse(JSON.stringify({
      findings: [
        { action: "test", result: "something" },
      ],
    }));

    await handler(
      createTask(),
      createMessage("URL: https://example.com\n\nContent"),
    );

    const addCall = (store.addFinding as any).mock.calls[0][0];
    expect(addCall.severity).toBe("info");
  });

  it("handles all valid severity values", async () => {
    const severities = ["info", "warning", "error", "critical"];

    for (const severity of severities) {
      mockChat.mockReset();
      (store.addFinding as any).mockClear();

      mockLLMResponse(JSON.stringify({
        findings: [{ action: "test", result: "result", severity }],
      }));

      await handler(
        createTask(),
        createMessage(`URL: https://example.com\n\nContent for ${severity}`),
      );

      const addCall = (store.addFinding as any).mock.calls[0][0];
      expect(addCall.severity).toBe(severity);
    }
  });

  it("handles non-JSON LLM response gracefully", async () => {
    mockLLMResponse("This is not a valid JSON response");

    const result = await handler(
      createTask(),
      createMessage("URL: https://example.com\n\nContent"),
    );

    expect(result.ok).toBe(true);
    // No findings stored
    expect(store.addFinding).not.toHaveBeenCalled();
  });

  it("continues processing when addFinding fails for one finding", async () => {
    (store.addFinding as any)
      .mockResolvedValueOnce(Err(new Error("db error")))
      .mockResolvedValueOnce(Ok(2));

    mockLLMResponse(JSON.stringify({
      findings: [
        { action: "test1", result: "r1", severity: "info" },
        { action: "test2", result: "r2", severity: "warning" },
      ],
    }));

    const result = await handler(
      createTask(),
      createMessage("URL: https://example.com\n\nContent"),
    );

    // Should still complete successfully
    expect(result.ok).toBe(true);
    // Both findings attempted
    expect(store.addFinding).toHaveBeenCalledTimes(2);
  });

  it("returns Err when LLM call fails", async () => {
    mockChat.mockResolvedValueOnce(Err(new Error("LLM error")));

    const result = await handler(
      createTask(),
      createMessage("URL: https://example.com\n\nContent"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("LLM error");
    }
  });

  it("extracts URL from message text", async () => {
    mockLLMResponse(JSON.stringify({ findings: [{ action: "t", result: "r", severity: "info" }] }));

    await handler(
      createTask(),
      createMessage("URL: https://specific.example.com/path\n\nPage content"),
    );

    const addCall = (store.addFinding as any).mock.calls[0][0];
    expect(addCall.url).toBe("https://specific.example.com/path");
  });

  it("uses 'unknown' when no URL in message", async () => {
    mockLLMResponse(JSON.stringify({ findings: [{ action: "t", result: "r", severity: "info" }] }));

    await handler(
      createTask(),
      createMessage("Some page content without a URL"),
    );

    const addCall = (store.addFinding as any).mock.calls[0][0];
    expect(addCall.url).toBe("unknown");
  });
});
