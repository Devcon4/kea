import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { A2AClient } from "./client.js";

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    headers: new Headers(),
    redirected: false,
    statusText: "OK",
    type: "basic",
    url: "",
    clone: () => jsonResponse(body, status),
    body: null,
    bodyUsed: false,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob()),
    formData: () => Promise.resolve(new FormData()),
    text: () => Promise.resolve(JSON.stringify(body)),
    bytes: () => Promise.resolve(new Uint8Array()),
  } as Response;
}

describe("A2AClient", () => {
  let client: A2AClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new A2AClient("http://localhost:3000");
  });

  describe("constructor", () => {
    it("strips trailing slash from base URL", () => {
      const c = new A2AClient("http://example.com/");
      // We verify this indirectly by checking fetch URL
      mockFetch.mockResolvedValueOnce(jsonResponse({ name: "test" }));
      c.getAgentCard();
      expect(mockFetch).toHaveBeenCalledWith(
        "http://example.com/.well-known/agent-card.json",
      );
    });
  });

  describe("getAgentCard", () => {
    const fakeCard = {
      name: "remote-agent",
      description: "Remote agent",
      version: "1.0.0",
    };

    it("fetches agent card from well-known URL", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(fakeCard));

      const result = await client.getAgentCard();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe("remote-agent");
      }
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/.well-known/agent-card.json",
      );
    });

    it("caches card after first fetch", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(fakeCard));

      await client.getAgentCard();
      await client.getAgentCard();

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("returns Err on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 404));

      const result = await client.getAgentCard();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("404");
      }
    });

    it("returns Err on network error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network down"));

      const result = await client.getAgentCard();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("network down");
      }
    });
  });

  describe("sendMessage", () => {
    const fakeResponse = {
      task: { id: "task-1", status: { state: "TASK_STATE_COMPLETED" } },
    };

    it("sends text as a message part", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(fakeResponse));

      const result = await client.sendMessage("hello agent");

      expect(result.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/message:send",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }),
      );

      // Verify body contains the text
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.message.parts[0].text).toBe("hello agent");
      expect(callBody.message.role).toBe("ROLE_USER");
    });

    it("includes contextId and taskId in message", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(fakeResponse));

      await client.sendMessage("hi", {
        contextId: "ctx-1",
        taskId: "task-1",
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.message.contextId).toBe("ctx-1");
      expect(callBody.message.taskId).toBe("task-1");
    });

    it("includes metadata in request", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(fakeResponse));

      await client.sendMessage("hi", {
        metadata: { source: "test" },
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.metadata).toEqual({ source: "test" });
    });

    it("returns Err on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));

      const result = await client.sendMessage("fail");
      expect(result.ok).toBe(false);
    });
  });

  describe("sendData", () => {
    it("sends multiple parts", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ task: { id: "t1" } }),
      );

      const result = await client.sendData([
        { text: "part one" },
        { text: "part two" },
      ]);

      expect(result.ok).toBe(true);
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.message.parts).toHaveLength(2);
    });
  });

  describe("getTask", () => {
    it("fetches task by id", async () => {
      const fakeTask = {
        id: "task-123",
        status: { state: "TASK_STATE_COMPLETED" },
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(fakeTask));

      const result = await client.getTask("task-123");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe("task-123");
      }
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/tasks/task-123",
      );
    });

    it("returns Err on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 404));

      const result = await client.getTask("nope");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("404");
      }
    });
  });
});
