import { Ok, Err } from "../result.js";
import type { Result } from "../result.js";
import { chat } from "../llm/client.js";
import type { ChatCompletionMessageParam } from "../llm/client.js";
import type { AgentCard, Task, Message } from "../a2a/types.js";
import type { TaskHandler, TaskHandlerResult } from "../a2a/server.js";
import type { DataStore, SitemapStats, SitemapEntry } from "../memory/data-store.js";
import { createLogger } from "../logger.js";

const log = createLogger("coordinator");

const SYSTEM_PROMPT = `You are the coordinator agent for Kea, an autonomous chaos testing tool.
You plan the next batch of work by analyzing the sitemap state and issuing commands.

Respond with a JSON object containing a "commands" array. Each command is one of:

  { "type": "navigate", "url": "<discovered page URL>" }
    — Visit and extract links from a page. Pick URLs from the unvisited list.

  { "type": "test", "url": "<visited page URL>" }
    — Run chaos tests on a visited page. Pick URLs from the untested list.

  { "type": "invalidate", "url": "<page URL>" }
    — Mark a page as stale so it gets re-crawled and re-tested.
      Use when you suspect data may be outdated (e.g. page was visited long ago).

  { "type": "remove", "url": "<page URL>" }
    — Remove a page from the sitemap entirely (e.g. looks like a dead/irrelevant URL).

  { "type": "done", "reason": "<why>" }
    — Signal that exploration is complete. Use when no useful work remains.

Rules:
- You may return multiple commands per batch (e.g. 1 navigate + 3 test).
- Navigate commands use a page's browser + DOM extraction — they don't need an LLM.
- Test commands run the tester LLM agent on page content.
- Keep the batch between 1-5 commands to stay focused.
- If there are unvisited pages, always include at least 1 navigate.
- If there are untested visited pages, include test commands to keep workers busy.
- A test runs concurrently with navigation, so feel free to mix them.
- If all pages are tested and no new pages are discovered, return done.`;

export const agentCard: AgentCard = {
  name: "coordinator",
  description:
    "Plans exploration batches and manages the agent swarm for Kea.",
  supportedInterfaces: [
    { url: "local", protocolBinding: "HTTP+JSON", protocolVersion: "1.0.0" },
  ],
  version: "0.2.0",
  capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    {
      id: "plan-batch",
      name: "Plan Batch",
      description: "Analyze sitemap state and emit a batch of commands for the worker pool.",
      tags: ["planning", "coordination", "batch"],
    },
    {
      id: "manage-staleness",
      name: "Manage Staleness",
      description: "Identify and invalidate stale or outdated page data.",
      tags: ["staleness", "invalidation"],
    },
  ],
};

// -- Command types (exported for use by the loop) --

export type NavigateCommand = { type: "navigate"; url: string };
export type TestCommand = { type: "test"; url: string };
export type InvalidateCommand = { type: "invalidate"; url: string };
export type RemoveCommand = { type: "remove"; url: string };
export type DoneCommand = { type: "done"; reason: string };

export type CoordinatorCommand =
  | NavigateCommand
  | TestCommand
  | InvalidateCommand
  | RemoveCommand
  | DoneCommand;

export type CoordinatorPlan = {
  commands: CoordinatorCommand[];
};

export type AgentDeps = {
  store: DataStore;
};

/** Parse the coordinator LLM response into a validated plan. */
export function parsePlan(text: string): CoordinatorPlan {
  // Strip markdown code fences if present
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const jsonText = fenceMatch ? fenceMatch[1].trim() : text.trim();
  // Try to find a JSON object
  const objMatch = jsonText.match(/\{[\s\S]*\}/);
  if (!objMatch) return { commands: [{ type: "done", reason: "no JSON in response" }] };

  try {
    const parsed = JSON.parse(objMatch[0]) as { commands?: unknown[] };
    if (!Array.isArray(parsed.commands) || parsed.commands.length === 0) {
      return { commands: [{ type: "done", reason: "empty commands array" }] };
    }

    const valid: CoordinatorCommand[] = [];
    for (const cmd of parsed.commands) {
      if (typeof cmd !== "object" || cmd === null) continue;
      const c = cmd as Record<string, string>;
      switch (c.type) {
        case "navigate":
        case "test":
        case "invalidate":
        case "remove":
          if (typeof c.url === "string" && c.url) valid.push(c as CoordinatorCommand);
          break;
        case "done":
          valid.push({ type: "done", reason: c.reason ?? "" });
          break;
      }
    }
    return { commands: valid.length > 0 ? valid : [{ type: "done", reason: "no valid commands parsed" }] };
  } catch {
    return { commands: [{ type: "done", reason: "failed to parse coordinator response" }] };
  }
}

export function createHandler(deps: AgentDeps): TaskHandler {
  return async (
    _task: Task,
    message: Message,
  ): Promise<Result<TaskHandlerResult, Error>> => {
    const userText =
      message.parts.map((p) => p.text ?? "").join("\n").trim() ||
      "What should we do next?";

    const statsResult = await deps.store.getSitemapStats();
    if (!statsResult.ok) {
      log.error({ error: statsResult.error }, "failed to get sitemap stats");
      return Err(statsResult.error);
    }

    const unvisitedResult = await deps.store.getUnvisitedPages(10);
    if (!unvisitedResult.ok) {
      log.error({ error: unvisitedResult.error }, "failed to get unvisited pages");
      return Err(unvisitedResult.error);
    }

    const untestedResult = await deps.store.getUntestedPages(10);
    if (!untestedResult.ok) {
      log.error({ error: untestedResult.error }, "failed to get untested pages");
      return Err(untestedResult.error);
    }

    const stats = statsResult.value;
    const unvisited = unvisitedResult.value;
    const untested = untestedResult.value;

    const contextBlock = [
      `Sitemap stats: ${JSON.stringify(stats)}`,
      `Unvisited pages (up to 10): ${JSON.stringify(unvisited.map((p) => p.url))}`,
      `Visited but untested pages (up to 10): ${JSON.stringify(untested.map((p) => p.url))}`,
    ].join("\n");

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Current state:\n${contextBlock}\n\nUser request: ${userText}`,
      },
    ];

    log.debug({ stats, unvisitedCount: unvisited.length, untestedCount: untested.length }, "requesting coordination plan");

    const chatResult = await chat({ messages, temperature: 0.3 });
    if (!chatResult.ok) {
      log.error({ error: chatResult.error }, "LLM call failed");
      return Err(chatResult.error);
    }

    const responseText =
      chatResult.value.choices[0]?.message?.content ?? "No response from LLM";

    // Save agent message to the store
    await deps.store.addMessage({
      agentId: "coordinator",
      content: responseText,
      thinking: `Current state:\n${contextBlock}\n\nUser request: ${userText}`,
      timestamp: Date.now(),
    });

    log.info({ response: responseText }, "coordination plan received");

    return Ok({
      state: "TASK_STATE_COMPLETED",
      response: [{ text: responseText }],
    });
  };
}

/** Build a deterministic fallback plan when the LLM is unavailable or slow. */
export function buildFallbackPlan(
  stats: SitemapStats,
  unvisited: SitemapEntry[],
  untested: SitemapEntry[],
): CoordinatorPlan {
  const commands: CoordinatorCommand[] = [];

  // Always include 1 navigate if unvisited pages exist
  if (unvisited.length > 0) {
    commands.push({ type: "navigate", url: unvisited[0].url });
  }

  // Fill remaining slots with test commands (up to 3)
  for (const page of untested.slice(0, 3)) {
    commands.push({ type: "test", url: page.url });
  }

  if (commands.length === 0) {
    commands.push({ type: "done", reason: "all pages visited and tested" });
  }

  return { commands };
}
