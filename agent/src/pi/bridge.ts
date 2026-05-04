import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { createLogger } from "../logger.js";
import type { DataStore } from "../memory/data-store.js";

const log = createLogger("pi-bridge");

/**
 * Subscribe a Pi `AgentSession` to a Kea `DataStore` so every visible decision
 * the LLM emits lands in the Postgres message log via `addMessage(...)`.
 *
 * Per [ADR-023](../../../docs/adr/023-pi-session-manager-postgres.md), the
 * Postgres log is the single canonical message store; live and historical
 * surfaces (FDD-0006) read from there. The bridge is therefore the only place
 * "Pi event" → "Kea message" translation lives.
 *
 * Mapping:
 *
 * - `tool_execution_start` → one `addMessage` row per tool call, written at the
 *   moment the call is dispatched. This is critical so a coordinator-level
 *   tool call (e.g. `discover_features`) is timestamped BEFORE the sub-agent
 *   messages it spawns. Otherwise dashboards display sub-agent activity above
 *   the parent call, which is misleading.
 * - `turn_end` → one `addMessage` row carrying the assistant's final prose and
 *   accumulated thinking, but ONLY if there is text to surface; tool calls are
 *   already covered by `tool_execution_start`.
 * - Tool results are NOT surfaced through the dashboard log; they are visible
 *   to the LLM internally. Surface them later as a verbose level if FDD-0006
 *   grows that knob.
 *
 * Errors writing to the store are logged and swallowed — losing a single
 * message is preferable to crashing the agent loop. FDD-0006's "no silent
 * drops" promise is upheld at the Postgres write layer; the bridge's job is
 * best-effort live mirroring.
 */
export function bridgeSessionToStore(
  session: AgentSession,
  agentId: string,
  store: DataStore,
): () => void {
  const unsubscribe = session.subscribe((event) => {
    void handleEvent(event, agentId, store);
  });
  return unsubscribe;
}

async function handleEvent(
  event: { type: string; [key: string]: unknown },
  agentId: string,
  store: DataStore,
): Promise<void> {
  if (event.type === "tool_execution_start") {
    const e = event as unknown as { toolName?: string; args?: unknown };
    if (typeof e.toolName !== "string") return;
    await persist(store, agentId, `→ ${e.toolName}(${safeStringify(e.args)})`, null);
    return;
  }

  if (event.type === "turn_end") {
    const message = (event as unknown as { message?: { role: string; content?: unknown } }).message;
    if (!message || message.role !== "assistant") return;

    const content = message.content;
    if (!Array.isArray(content)) return;

    let assistantText = "";
    let thinking = "";

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: string; text?: string; thinking?: string };
      if (b.type === "text" && typeof b.text === "string") {
        assistantText += (assistantText ? "\n" : "") + b.text;
      } else if (b.type === "thinking" && typeof b.thinking === "string") {
        thinking += (thinking ? "\n" : "") + b.thinking;
      }
    }

    // Skip empty messages: tool-only turns already wrote their tool-call rows
    // via tool_execution_start. Only surface prose/thinking here.
    // No prose this turn — nothing user-facing to record. Tool calls were
    // already persisted via tool_execution_start, and the DB rejects empty
    // content (CreateChatMessageSchema enforces min(1)).
    if (!assistantText) return;

    await persist(store, agentId, assistantText, thinking || null);
  }
}

async function persist(
  store: DataStore,
  agentId: string,
  content: string,
  thinking: string | null,
): Promise<void> {
  const result = await store.addMessage({
    agentId,
    content,
    thinking,
    timestamp: Date.now(),
  });
  if (!result.ok) {
    log.warn({ error: result.error.message, agentId }, "failed to persist assistant message");
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
