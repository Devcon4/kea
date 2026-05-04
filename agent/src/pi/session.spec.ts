import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { createKeaSession } from "./session.js";
import { bridgeSessionToStore } from "./bridge.js";
import { FakeDataStore, recordToolCalls } from "./test-harness.js";
import { loadLlmEnv } from "./env.js";

const ollamaBaseUrl = (process.env.LLM_BASE_URL ?? "http://localhost:11434/v1").replace(/\/+$/, "");
const probeOllama = async (): Promise<boolean> => {
  try {
    const res = await fetch(`${ollamaBaseUrl}/models`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
};

describe("pi session scaffold", () => {
  it("env loader honours LLM_* and provides sensible defaults", () => {
    const env = loadLlmEnv({ LLM_BASE_URL: "http://x:1/v1/", LLM_API_KEY: "k", LLM_MODEL: "m" });
    expect(env.baseUrl).toBe("http://x:1/v1");
    expect(env.apiKey).toBe("k");
    expect(env.model).toBe("m");
    expect(env.contextWindow).toBeGreaterThan(0);
    expect(env.maxTokens).toBeGreaterThan(0);
  });

  it("creates an in-memory session and emits a tool call against a real provider", async () => {
    const reachable = await probeOllama();
    if (!reachable) {
      // Skip rather than fail when the dev backend isn't up. The smoke test
      // is meant to validate Phase 0's claim end-to-end when Ollama is
      // available; CI environments without a model run the unit-only suite.
      console.warn("ollama not reachable at", ollamaBaseUrl, "— skipping live smoke test");
      return;
    }

    const echoTool = defineTool({
      name: "echo",
      label: "Echo",
      description: "Echo a single string back. Call exactly once.",
      parameters: Type.Object({
        text: Type.String({ description: "Text to echo." }),
      }),
      execute: async (_id, params) => ({
        content: [{ type: "text", text: params.text }],
        details: {},
        terminate: true,
      }),
    });

    const kea = await createKeaSession({
      role: "smoke",
      tools: [echoTool],
      systemPrompt:
        "You are a smoke test agent. The only available tool is `echo(text)`. " +
        "Call `echo` exactly once with the user's word, then stop.",
    });

    const store = new FakeDataStore();
    const unbridge = bridgeSessionToStore(kea.session, "smoke", store);
    const recorder = recordToolCalls(kea.session);

    try {
      await kea.session.prompt('Echo back the word "hello".');
      const echoCalls = recorder.calls.filter((c) => c.name === "echo");
      expect(echoCalls.length).toBeGreaterThanOrEqual(1);
      // The bridge should have recorded at least one assistant turn.
      expect(store.messages.some((m) => m.agentId === "smoke")).toBe(true);
    } finally {
      recorder.unsubscribe();
      unbridge();
      kea.dispose();
    }
  }, 120_000);
});
