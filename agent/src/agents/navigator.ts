import { Ok, Err } from "../result.js";
import type { Result } from "../result.js";
import { chat } from "../llm/client.js";
import type { ChatCompletionMessageParam } from "../llm/client.js";
import type { AgentCard, Task, Message } from "../a2a/types.js";
import type { TaskHandler, TaskHandlerResult } from "../a2a/server.js";
import type { DataStore } from "../memory/data-store.js";
import { createLogger } from "../logger.js";

const log = createLogger("navigator");

const SYSTEM_PROMPT = `You are the navigator agent for Kea, an autonomous chaos testing tool. Your job is to explore web pages. Given a URL, analyze the page content, identify interesting links, and describe what you find. Respond with a JSON object: { "title": "<page title>", "links": ["<absolute url1>", ...], "summary": "<what the page contains>" }

IMPORTANT: The "links" array must contain absolute URLs (e.g. "http://example.com/about.html"), NOT link text. Extract the href attribute from each link.`;

export const agentCard: AgentCard = {
  name: "navigator",
  description:
    "Explores web pages, extracts links, and builds the sitemap for the Kea agent swarm.",
  supportedInterfaces: [
    { url: "local", protocolBinding: "HTTP+JSON", protocolVersion: "1.0.0" },
  ],
  version: "0.1.0",
  capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    {
      id: "explore-page",
      name: "Explore Page",
      description: "Analyze a web page and extract its content and links.",
      tags: ["navigation", "exploration"],
    },
    {
      id: "build-sitemap",
      name: "Build Sitemap",
      description: "Update the sitemap with discovered page information.",
      tags: ["sitemap", "mapping"],
    },
  ],
};

export type AgentDeps = {
  store: DataStore;
};

export function createHandler(deps: AgentDeps): TaskHandler {
  return async (
    _task: Task,
    message: Message,
  ): Promise<Result<TaskHandlerResult, Error>> => {
    const userText = message.parts.map((p) => p.text ?? "").join("\n").trim();
    if (!userText) {
      return Err(new Error("no page content provided in message"));
    }

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userText },
    ];

    log.debug("requesting page analysis from LLM");

    const chatResult = await chat({ messages, temperature: 0.2 });
    if (!chatResult.ok) {
      log.error({ error: chatResult.error }, "LLM call failed");
      return Err(chatResult.error);
    }

    const responseText =
      chatResult.value.choices[0]?.message?.content ?? "No response from LLM";

    const parsed = parseLLMResponse(responseText);
    const pageUrl = parsed.url ?? extractUrl(userText) ?? "unknown";

    // Resolve relative links and filter out non-URLs (e.g. bare link text)
    const resolvedLinks = resolveLinks(parsed.links ?? [], pageUrl);

    const upsertResult = await deps.store.upsertPage({
      url: pageUrl,
      title: parsed.title ?? "",
      links: resolvedLinks,
      status: "visited",
      visitedAt: Date.now(),
    });

    if (!upsertResult.ok) {
      log.error({ error: upsertResult.error }, "failed to upsert page");
      return Err(upsertResult.error);
    }

    for (const link of resolvedLinks) {
      await deps.store.discoverPage(link);
    }

    log.info(
      { url: pageUrl, linkCount: resolvedLinks.length },
      "page processed",
    );

    return Ok({
      state: "TASK_STATE_COMPLETED",
      response: [{ text: responseText }],
    });
  };
}

type ParsedNavResponse = {
  url?: string;
  title?: string;
  links?: string[];
  summary?: string;
};

function parseLLMResponse(text: string): ParsedNavResponse {
  // Strip markdown code fences if present
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const jsonText = fenceMatch ? fenceMatch[1].trim() : text.trim();
  try {
    return JSON.parse(jsonText) as ParsedNavResponse;
  } catch {
    return {};
  }
}

function extractUrl(text: string): string | undefined {
  const match = /https?:\/\/[^\s"']+/.exec(text);
  return match?.[0];
}

/** Resolve relative links against the page URL and filter out non-URLs. */
function resolveLinks(links: string[], baseUrl: string): string[] {
  const resolved: string[] = [];
  for (const raw of links) {
    const link = raw.trim();
    // Skip bare words that aren't paths or absolute URLs
    if (!link.startsWith("/") && !link.startsWith("./") && !link.startsWith("../") && !link.startsWith("http")) continue;
    try {
      const url = new URL(link, baseUrl);
      if (url.protocol === "http:" || url.protocol === "https:") {
        resolved.push(url.toString());
      }
    } catch {
      // Not resolvable — skip
    }
  }
  return resolved;
}
