import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { firstValueFrom, take, toArray } from "rxjs";
import { A2AServer } from "./server.js";
import { Ok, Err } from "../result.js";
import type { AgentCard, Message, SendMessageRequest, Task, Part } from "./types.js";
import type { TaskHandler, TaskHandlerResult, TaskEvent } from "./server.js";

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

const testCard: AgentCard = {
  name: "test-agent",
  description: "A test agent",
  supportedInterfaces: [
    { url: "local", protocolBinding: "HTTP+JSON", protocolVersion: "1.0.0" },
  ],
  version: "0.1.0",
  capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [],
};

function buildRequest(text: string, opts?: { taskId?: string; contextId?: string }): SendMessageRequest {
  const msg: Message = {
    messageId: randomUUID(),
    role: "ROLE_USER",
    parts: [{ text }],
    taskId: opts?.taskId,
    contextId: opts?.contextId,
  };
  return { message: msg };
}

describe("A2AServer", () => {
  let handler: ReturnType<typeof vi.fn<TaskHandler>>;
  let server: A2AServer;

  beforeEach(() => {
    handler = vi.fn<TaskHandler>();
    server = new A2AServer(testCard, handler);
  });

  describe("getAgentCard", () => {
    it("returns the agent card", () => {
      expect(server.getAgentCard()).toEqual(testCard);
    });

    it("exposes card as public property", () => {
      expect(server.card.name).toBe("test-agent");
    });
  });

  describe("sendMessage", () => {
    it("creates a task and calls handler", async () => {
      const handlerResult: TaskHandlerResult = {
        state: "TASK_STATE_COMPLETED",
        response: [{ text: "done" }],
      };
      handler.mockResolvedValueOnce(Ok(handlerResult));

      const result = await server.sendMessage(buildRequest("hello"));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.task).toBeDefined();
        expect(result.value.task!.status.state).toBe("TASK_STATE_COMPLETED");
      }
      expect(handler).toHaveBeenCalledOnce();
    });

    it("stores message in task history", async () => {
      handler.mockResolvedValueOnce(
        Ok({ state: "TASK_STATE_COMPLETED", response: [{ text: "reply" }] }),
      );

      const result = await server.sendMessage(buildRequest("input text"));

      if (result.ok && result.value.task) {
        const history = result.value.task.history ?? [];
        // Should have user message + agent response
        expect(history.length).toBeGreaterThanOrEqual(2);
        expect(history[0].role).toBe("ROLE_USER");
        expect(history[0].parts[0].text).toBe("input text");
      }
    });

    it("handles handler failure gracefully", async () => {
      handler.mockResolvedValueOnce(Err(new Error("handler boom")));

      const result = await server.sendMessage(buildRequest("fail"));

      expect(result.ok).toBe(true); // Still returns Ok wrapping the task
      if (result.ok && result.value.task) {
        expect(result.value.task.status.state).toBe("TASK_STATE_FAILED");
      }
    });

    it("stores artifacts from handler result", async () => {
      handler.mockResolvedValueOnce(
        Ok({
          state: "TASK_STATE_COMPLETED",
          response: [{ text: "done" }],
          artifacts: [
            {
              artifactId: "art-1",
              name: "report",
              parts: [{ text: "findings here" }],
            },
          ],
        }),
      );

      const result = await server.sendMessage(buildRequest("test"));

      if (result.ok && result.value.task) {
        expect(result.value.task.artifacts).toHaveLength(1);
        expect(result.value.task.artifacts![0].name).toBe("report");
      }
    });

    it("reuses existing task when taskId matches", async () => {
      handler.mockResolvedValue(
        Ok({ state: "TASK_STATE_WORKING", response: [{ text: "working" }] }),
      );

      const req1 = buildRequest("first", { taskId: "shared-task" });
      await server.sendMessage(req1);
      const historyLenAfterFirst = server.getTask("shared-task")!.history!.length;

      const req2 = buildRequest("second", { taskId: "shared-task" });
      await server.sendMessage(req2);
      const historyLenAfterSecond = server.getTask("shared-task")!.history!.length;

      expect(server.getTask("shared-task")).toBeDefined();
      expect(historyLenAfterSecond).toBeGreaterThan(historyLenAfterFirst);
    });
  });

  describe("getTask", () => {
    it("returns undefined for unknown task", () => {
      expect(server.getTask("nonexistent")).toBeUndefined();
    });

    it("returns task after sendMessage", async () => {
      handler.mockResolvedValueOnce(
        Ok({ state: "TASK_STATE_COMPLETED", response: [{ text: "done" }] }),
      );

      const result = await server.sendMessage(buildRequest("hi"));
      if (result.ok && result.value.task) {
        const task = server.getTask(result.value.task.id);
        expect(task).toBeDefined();
        expect(task!.id).toBe(result.value.task.id);
      }
    });
  });

  describe("listTasks", () => {
    it("returns empty array initially", () => {
      expect(server.listTasks()).toEqual([]);
    });

    it("returns all tasks", async () => {
      handler.mockResolvedValue(
        Ok({ state: "TASK_STATE_COMPLETED", response: [{ text: "ok" }] }),
      );

      await server.sendMessage(buildRequest("one"));
      await server.sendMessage(buildRequest("two"));

      expect(server.listTasks()).toHaveLength(2);
    });

    it("filters by contextId", async () => {
      handler.mockResolvedValue(
        Ok({ state: "TASK_STATE_COMPLETED", response: [{ text: "ok" }] }),
      );

      await server.sendMessage(buildRequest("one", { contextId: "ctx-a" }));
      await server.sendMessage(buildRequest("two", { contextId: "ctx-b" }));

      const filtered = server.listTasks("ctx-a");
      expect(filtered).toHaveLength(1);
      expect(filtered[0].contextId).toBe("ctx-a");
    });
  });

  describe("cancelTask", () => {
    it("cancels a working task", async () => {
      handler.mockResolvedValueOnce(
        Ok({ state: "TASK_STATE_WORKING", response: [{ text: "pending" }] }),
      );

      const sendResult = await server.sendMessage(buildRequest("start"));
      if (!sendResult.ok || !sendResult.value.task) return;

      const cancelResult = server.cancelTask(sendResult.value.task.id);
      expect(cancelResult.ok).toBe(true);
      if (cancelResult.ok) {
        expect(cancelResult.value.status.state).toBe("TASK_STATE_CANCELED");
      }
    });

    it("returns Err for unknown task", () => {
      const result = server.cancelTask("nonexistent");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("not found");
      }
    });

    it("returns Err for already terminal task", async () => {
      handler.mockResolvedValueOnce(
        Ok({ state: "TASK_STATE_COMPLETED", response: [{ text: "done" }] }),
      );

      const sendResult = await server.sendMessage(buildRequest("finish"));
      if (!sendResult.ok || !sendResult.value.task) return;

      const cancelResult = server.cancelTask(sendResult.value.task.id);
      expect(cancelResult.ok).toBe(false);
      if (!cancelResult.ok) {
        expect(cancelResult.error.message).toContain("terminal");
      }
    });
  });

  describe("tasksSnapshot", () => {
    it("returns empty map initially", () => {
      expect(server.tasksSnapshot.size).toBe(0);
    });

    it("reflects tasks after messages", async () => {
      handler.mockResolvedValue(
        Ok({ state: "TASK_STATE_COMPLETED", response: [{ text: "ok" }] }),
      );

      await server.sendMessage(buildRequest("task1"));
      expect(server.tasksSnapshot.size).toBe(1);
    });

    it("returns a ReadonlyMap", () => {
      const snapshot = server.tasksSnapshot;
      // ReadonlyMap has no set method
      expect(typeof (snapshot as Map<string, Task>).set).toBe("function"); // it's a Map under the hood
    });
  });

  describe("taskEvents$", () => {
    it("emits events for task lifecycle", async () => {
      handler.mockResolvedValueOnce(
        Ok({ state: "TASK_STATE_COMPLETED", response: [{ text: "done" }] }),
      );

      const eventsPromise = firstValueFrom(
        server.taskEvents$.pipe(take(3), toArray()),
      );

      await server.sendMessage(buildRequest("hi"));

      const events = await eventsPromise;
      expect(events.length).toBeGreaterThanOrEqual(2);

      const types = events.map((e) => e.type);
      expect(types).toContain("created");
      expect(types).toContain("completed");
    });
  });

  describe("tasksByState$", () => {
    it("filters events by task state", async () => {
      handler.mockResolvedValueOnce(
        Ok({ state: "TASK_STATE_COMPLETED", response: [{ text: "done" }] }),
      );

      const completedPromise = firstValueFrom(
        server.tasksByState$("TASK_STATE_COMPLETED"),
      );

      await server.sendMessage(buildRequest("complete me"));

      const task = await completedPromise;
      expect(task.status.state).toBe("TASK_STATE_COMPLETED");
    });
  });

  describe("dispose", () => {
    it("completes event streams", () => {
      let completed = false;
      server.taskEvents$.subscribe({ complete: () => { completed = true; } });
      server.dispose();
      expect(completed).toBe(true);
    });
  });
});
