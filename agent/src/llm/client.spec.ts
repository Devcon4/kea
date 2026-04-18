import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockCreate } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

vi.mock("openai", () => {
  return {
    default: class {
      constructor() {
        // Bracket notation avoids Vitest hoisting collision with the imported `chat` identifier
        (this as Record<string, unknown>)["chat"] = { completions: { create: mockCreate } };
      }
    },
  };
});

import { getLLMConfig, configureLLM, chat, toOpenAITools } from "./client.js";
import type { ToolDefinition } from "./client.js";

const fakeCompletion = {
  id: "c-1", object: "chat.completion", created: 0, model: "m",
  choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop", logprobs: null }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

describe("getLLMConfig", () => {
  it("returns defaults", () => {
    expect(getLLMConfig()).toHaveProperty("model");
    expect(getLLMConfig()).toHaveProperty("baseURL");
    expect(getLLMConfig()).toHaveProperty("apiKey");
  });
});

describe("configureLLM", () => {
  afterEach(() => configureLLM({ baseURL: "http://localhost:11434/v1", apiKey: "ollama", model: "gemma4" }));

  it("merges partial config", () => {
    configureLLM({ model: "llama3" });
    expect(getLLMConfig().model).toBe("llama3");
  });

  it("updates base URL", () => {
    configureLLM({ baseURL: "http://vllm:8000/v1" });
    expect(getLLMConfig().baseURL).toBe("http://vllm:8000/v1");
  });

  it("resets client on reconfigure", async () => {
    mockCreate.mockResolvedValueOnce(fakeCompletion);
    await chat({ messages: [{ role: "user", content: "hi" }] });
    configureLLM({ model: "new-model" });
    mockCreate.mockResolvedValueOnce(fakeCompletion);
    const r = await chat({ messages: [{ role: "user", content: "hi" }] });
    expect(r.ok).toBe(true);
  });
});

describe("chat", () => {
  beforeEach(() => mockCreate.mockReset());
  afterEach(() => configureLLM({ baseURL: "http://localhost:11434/v1", apiKey: "ollama", model: "gemma4" }));

  it("returns Ok on success", async () => {
    mockCreate.mockResolvedValueOnce(fakeCompletion);
    const r = await chat({ messages: [{ role: "user", content: "test" }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.choices[0].message.content).toBe("Hello");
  });

  it("passes model from config", async () => {
    mockCreate.mockResolvedValueOnce(fakeCompletion);
    configureLLM({ model: "test-model" });
    await chat({ messages: [{ role: "user", content: "hi" }] });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: "test-model" }));
  });

  it("applies default temperature and maxTokens", async () => {
    mockCreate.mockResolvedValueOnce(fakeCompletion);
    await chat({ messages: [{ role: "user", content: "hi" }] });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0.7, max_tokens: 4096 }));
  });

  it("respects custom options", async () => {
    mockCreate.mockResolvedValueOnce(fakeCompletion);
    await chat({ messages: [{ role: "user", content: "hi" }], temperature: 0.1, maxTokens: 256 });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0.1, max_tokens: 256 }));
  });

  it("passes tools", async () => {
    mockCreate.mockResolvedValueOnce(fakeCompletion);
    const tools = toOpenAITools([{ name: "x", description: "X", parameters: {} }]);
    await chat({ messages: [{ role: "user", content: "hi" }], tools });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ tools }));
  });

  it("omits empty tools", async () => {
    mockCreate.mockResolvedValueOnce(fakeCompletion);
    await chat({ messages: [{ role: "user", content: "hi" }], tools: [] });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ tools: undefined }));
  });

  it("returns Err on throw", async () => {
    mockCreate.mockRejectedValueOnce(new Error("rate limited"));
    const r = await chat({ messages: [{ role: "user", content: "hi" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe("rate limited");
  });
});

describe("toOpenAITools", () => {
  it("converts to ChatCompletionTool format", () => {
    const defs: ToolDefinition[] = [{ name: "search", description: "Search", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }];
    const result = toOpenAITools(defs);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "function", function: { name: "search", description: "Search", parameters: defs[0].parameters } });
  });

  it("returns empty for empty input", () => {
    expect(toOpenAITools([])).toEqual([]);
  });

  it("converts multiple tools", () => {
    const defs: ToolDefinition[] = [{ name: "a", description: "A", parameters: {} }, { name: "b", description: "B", parameters: {} }];
    expect(toOpenAITools(defs)).toHaveLength(2);
  });
});