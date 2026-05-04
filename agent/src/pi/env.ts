/**
 * LLM provider configuration from environment.
 *
 * The env contract preserved from ADR-006 even though its runtime is now Pi
 * ([ADR-021](../../../docs/adr/021-pi-sdk-as-agent-runtime.md)): the same three
 * variables route Kea to Ollama (dev), vLLM (production), or any other
 * OpenAI-compatible endpoint.
 */
export type LlmEnv = {
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  maxTokens: number;
};

/**
 * Logical provider name registered with Pi's `ModelRegistry`. Pi's auth
 * resolution and model discovery key off this string; we keep it stable so
 * that runtime API key overrides target a known name.
 */
export const KEA_PROVIDER_NAME = "kea-llm";

/**
 * Read the LLM env contract. Fails loudly when a required value is missing
 * rather than letting Pi resolve a wildly different default.
 */
export function loadLlmEnv(env: NodeJS.ProcessEnv = process.env): LlmEnv {
  const baseUrl = (env.LLM_BASE_URL ?? "http://localhost:11434/v1").replace(/\/+$/, "");
  const apiKey = env.LLM_API_KEY ?? "ollama";
  const model = env.LLM_MODEL ?? "gemma4:e4b";
  const contextWindow = parseIntStrict(env.LLM_CONTEXT_WINDOW, 32_768);
  const maxTokens = parseIntStrict(env.LLM_MAX_TOKENS, 4_096);
  return { baseUrl, apiKey, model, contextWindow, maxTokens };
}

function parseIntStrict(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
