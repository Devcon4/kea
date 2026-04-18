import { Ok, Err } from "../result.js";
import type { Result } from "../result.js";
import { chat } from "../llm/client.js";
import type { ChatCompletionMessageParam } from "../llm/client.js";
import type { AgentCard, Task, Message } from "../a2a/types.js";
import type { TaskHandler, TaskHandlerResult } from "../a2a/server.js";
import type { DataStore, Severity } from "../memory/data-store.js";
import { createLogger } from "../logger.js";

const log = createLogger("tester");

const SYSTEM_PROMPT = `You are the tester agent for Kea, an autonomous chaos testing tool. Your job is to analyze page content and identify potential issues, bugs, or interesting behaviors. Given page content, identify: broken links, accessibility issues, form validation problems, unexpected behaviors, error states. Respond with a JSON object: { "findings": [{ "action": "<what was tested>", "result": "<what happened>", "severity": "info" | "warning" | "error" | "critical" }] }`;

export const agentCard: AgentCard = {
  name: "tester",
  description:
    "Analyzes page content for issues, bugs, and potential vulnerabilities for the Kea agent swarm.",
  supportedInterfaces: [
    { url: "local", protocolBinding: "HTTP+JSON", protocolVersion: "1.0.0" },
  ],
  version: "0.1.0",
  capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    {
      id: "test-interactions",
      name: "Test Interactions",
      description: "Analyze page content and identify potential issues.",
      tags: ["testing", "analysis"],
    },
    {
      id: "report-findings",
      name: "Report Findings",
      description: "Report discovered issues with severity classification.",
      tags: ["reporting", "findings"],
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

    const pageUrl = extractUrl(userText) ?? "unknown";

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userText },
    ];

    log.debug({ url: pageUrl }, "requesting page analysis from LLM");

    const chatResult = await chat({ messages, temperature: 0.3 });
    if (!chatResult.ok) {
      log.error({ error: chatResult.error }, "LLM call failed");
      return Err(chatResult.error);
    }

    const responseText =
      chatResult.value.choices[0]?.message?.content ?? "No response from LLM";

    // Save agent message to the store
    await deps.store.addMessage({
      agentId: "tester",
      content: responseText,
      thinking: userText,
      timestamp: Date.now(),
    });

    const parsed = parseLLMResponse(responseText);

    for (const finding of parsed.findings ?? []) {
      const addResult = await deps.store.addFinding({
        url: pageUrl,
        agentId: "tester",
        action: finding.action ?? "unknown",
        result: finding.result ?? "unknown",
        severity: validSeverity(finding.severity),
        timestamp: Date.now(),
      });

      if (!addResult.ok) {
        log.warn({ error: addResult.error, finding }, "failed to store finding");
      }
    }

    log.info(
      { url: pageUrl, findingCount: parsed.findings?.length ?? 0 },
      "testing complete",
    );

    return Ok({
      state: "TASK_STATE_COMPLETED",
      response: [{ text: responseText }],
    });
  };
}

type ParsedFinding = {
  action?: string;
  result?: string;
  severity?: string;
};

type ParsedTestResponse = {
  findings?: ParsedFinding[];
};

function parseLLMResponse(text: string): ParsedTestResponse {
  // Strip markdown code fences if present
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const jsonText = fenceMatch ? fenceMatch[1].trim() : text.trim();
  try {
    return JSON.parse(jsonText) as ParsedTestResponse;
  } catch {
    return {};
  }
}

const VALID_SEVERITIES = new Set<Severity>(["info", "warning", "error", "critical"]);

function validSeverity(value?: string): Severity {
  if (value && VALID_SEVERITIES.has(value as Severity)) return value as Severity;
  return "info";
}

function extractUrl(text: string): string | undefined {
  const match = /https?:\/\/[^\s"']+/.exec(text);
  return match?.[0];
}
