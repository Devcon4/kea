import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@mariozechner/pi-coding-agent";
import type {
  AgentSession,
  CreateAgentSessionResult,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import { createLogger } from "../logger.js";
import { KEA_PROVIDER_NAME, loadLlmEnv } from "./env.js";
import type { LlmEnv } from "./env.js";

const log = createLogger("pi-session");

/**
 * Inputs for creating a Kea agent session.
 *
 * Per [ADR-023](../../../docs/adr/023-pi-session-manager-postgres.md), the
 * session is in-memory; Postgres remains the canonical message log via the
 * separate event bridge. Per [ADR-012](../../../docs/adr/012-container-security.md),
 * extensions are passed explicitly — we never read from
 * `~/.config/pi/extensions/`.
 */
export type CreateKeaSessionInput = {
  /** Logical role used as the message-log `agentId` (e.g. "coordinator", "tester"). */
  role: string;
  /** Tools the LLM may call. The full set the orchestrator can dispatch. */
  tools: ToolDefinition[];
  /** System prompt for this role. */
  systemPrompt: string;
  /** Optional override of the env-resolved LLM config (used by tests). */
  llmEnv?: LlmEnv;
  /** Optional override of `AuthStorage` (used by tests with a fake provider). */
  authStorage?: AuthStorage;
  /** Optional override of `ModelRegistry` (used by tests). */
  modelRegistry?: ModelRegistry;
  /** Disable retries (default behaviour: leave Pi defaults). */
  disableRetry?: boolean;
};

export type KeaAgentSession = {
  session: AgentSession;
  model: Model<any>;
  llmEnv: LlmEnv;
  /** Dispose the session and free underlying resources. */
  dispose(): void;
};

/**
 * Create a Pi `AgentSession` configured for Kea: in-memory session manager,
 * in-memory auth storage, in-memory settings, an OpenAI-compatible custom
 * provider pointed at `LLM_BASE_URL`, and the caller's tools as `customTools`.
 *
 * The returned session's events are NOT yet bridged to Postgres — the caller
 * attaches the bridge separately so a single bridge implementation can target
 * coordinator and any sub-agents under one attribution.
 */
export async function createKeaSession(input: CreateKeaSessionInput): Promise<KeaAgentSession> {
  const llmEnv = input.llmEnv ?? loadLlmEnv();

  const authStorage = input.authStorage ?? AuthStorage.inMemory();
  const modelRegistry = input.modelRegistry ?? ModelRegistry.inMemory(authStorage);

  // Runtime API key override; not persisted to disk.
  authStorage.setRuntimeApiKey(KEA_PROVIDER_NAME, llmEnv.apiKey);

  // Register the OpenAI-compatible endpoint as a single-model provider.
  // ADR-021: Pi adapts to the LLM_BASE_URL contract preserved from ADR-006.
  modelRegistry.registerProvider(KEA_PROVIDER_NAME, {
    baseUrl: llmEnv.baseUrl,
    api: "openai-completions",
    apiKey: "LLM_API_KEY",
    models: [
      {
        id: llmEnv.model,
        name: llmEnv.model,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: llmEnv.contextWindow,
        maxTokens: llmEnv.maxTokens,
      },
    ],
  });

  const model = modelRegistry.find(KEA_PROVIDER_NAME, llmEnv.model);
  if (!model) {
    throw new Error(
      `failed to resolve model ${KEA_PROVIDER_NAME}/${llmEnv.model} after provider registration`,
    );
  }

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: input.disableRetry ? { enabled: false } : undefined,
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    // ADR-012: writable mounts are /data and /tmp. We disable every
    // discovery channel below, but DefaultResourceLoader still requires a
    // string here, so point at a /tmp path that is never written to.
    agentDir: "/tmp/kea-pi",
    settingsManager,
    systemPromptOverride: () => input.systemPrompt,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  const result: CreateAgentSessionResult = await createAgentSession({
    cwd: process.cwd(),
    authStorage,
    modelRegistry,
    model,
    thinkingLevel: "off",
    // Disable Pi's default built-in coding tools; keep our custom tools.
    noTools: "builtin",
    customTools: input.tools,
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
  });

  log.info(
    {
      role: input.role,
      model: llmEnv.model,
      baseUrl: llmEnv.baseUrl,
      toolCount: input.tools.length,
    },
    "pi session created",
  );

  return {
    session: result.session,
    model,
    llmEnv,
    dispose: () => result.session.dispose(),
  };
}
