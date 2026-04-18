import { randomUUID } from "node:crypto";
import { Ok, tryCatch } from "../result.js";
import type { Result } from "../result.js";
import type {
  AgentCard,
  Message,
  SendMessageRequest,
  SendMessageResponse,
  Task,
  Part,
} from "./types.js";
import { createLogger } from "../logger.js";

const log = createLogger("a2a-client");

export type SendMessageOptions = {
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
};

export class A2AClient {
  private baseUrl: string;
  private cachedCard: AgentCard | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async getAgentCard(): Promise<Result<AgentCard, Error>> {
    if (this.cachedCard) return Ok(this.cachedCard);

    return tryCatch(async () => {
      const res = await fetch(`${this.baseUrl}/.well-known/agent-card.json`);
      if (!res.ok) throw new Error(`Failed to fetch agent card: ${res.status}`);
      const card = (await res.json()) as AgentCard;
      this.cachedCard = card;
      return card;
    });
  }

  async sendMessage(
    text: string,
    options?: SendMessageOptions,
  ): Promise<Result<SendMessageResponse, Error>> {
    return this.sendParts([{ text }], options);
  }

  async sendData(
    parts: Part[],
    options?: SendMessageOptions,
  ): Promise<Result<SendMessageResponse, Error>> {
    return this.sendParts(parts, options);
  }

  async getTask(taskId: string): Promise<Result<Task, Error>> {
    return tryCatch(async () => {
      const res = await fetch(`${this.baseUrl}/tasks/${taskId}`);
      if (!res.ok) throw new Error(`A2A getTask failed: ${res.status}`);
      return (await res.json()) as Task;
    });
  }

  private async sendParts(
    parts: Part[],
    options?: SendMessageOptions,
  ): Promise<Result<SendMessageResponse, Error>> {
    const message: Message = {
      messageId: randomUUID(),
      role: "ROLE_USER",
      parts,
      contextId: options?.contextId,
      taskId: options?.taskId,
    };

    const req: SendMessageRequest = {
      message,
      metadata: options?.metadata,
    };

    log.debug({ baseUrl: this.baseUrl, parts: parts.length }, "sending message");

    return tryCatch(async () => {
      const res = await fetch(`${this.baseUrl}/message:send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      if (!res.ok) throw new Error(`A2A sendMessage failed: ${res.status}`);
      return (await res.json()) as SendMessageResponse;
    });
  }
}
