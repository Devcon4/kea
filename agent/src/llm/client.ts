import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolChoiceOption,
  ChatCompletion,
} from "openai/resources/chat/completions";
import { tryCatch } from "../result.js";
import type { Result } from "../result.js";
import { createLogger } from "../logger.js";

export type { ChatCompletionMessageParam, ChatCompletionTool, ChatCompletion };

const log = createLogger("llm");

export type LLMConfig = {
  baseURL: string;
  apiKey: string;
  model: string;
};

const DEFAULT_CONFIG: LLMConfig = {
  baseURL: process.env.LLM_BASE_URL ?? "http://localhost:11434/v1",
  apiKey: process.env.LLM_API_KEY ?? "ollama",
  model: process.env.LLM_MODEL ?? "gemma4",
};

let clientInstance: OpenAI | null = null;
let activeConfig: LLMConfig = { ...DEFAULT_CONFIG };

export function configureLLM(config: Partial<LLMConfig>): void {
  activeConfig = { ...activeConfig, ...config };
  clientInstance = null;
}

export function getLLMConfig(): Readonly<LLMConfig> {
  return activeConfig;
}

function getClient(): OpenAI {
  if (clientInstance) return clientInstance;

  clientInstance = new OpenAI({
    baseURL: activeConfig.baseURL,
    apiKey: activeConfig.apiKey,
  });
  return clientInstance;
}

export type ChatOptions = {
  messages: ChatCompletionMessageParam[];
  tools?: ChatCompletionTool[];
  toolChoice?: ChatCompletionToolChoiceOption;
  temperature?: number;
  maxTokens?: number;
};

export async function chat(options: ChatOptions): Promise<Result<ChatCompletion, Error>> {
  const client = getClient();

  log.info(
    {
      model: activeConfig.model,
      messageCount: options.messages.length,
      tools: options.tools?.map((t) => "function" in t ? t.function.name : t.type),
      messages: options.messages.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content.slice(0, 500) : "[structured]",
      })),
    },
    "chat request",
  );

  const result = await tryCatch(() =>
    client.chat.completions.create({
      model: activeConfig.model,
      messages: options.messages,
      tools: options.tools?.length ? options.tools : undefined,
      tool_choice: options.toolChoice,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 4096,
    }),
  );

  if (result.ok) {
    const choice = result.value.choices[0];
    log.info(
      {
        model: result.value.model,
        finishReason: choice?.finish_reason,
        content: choice?.message?.content?.slice(0, 500),
        toolCalls: choice?.message?.tool_calls?.map((tc) =>
          "function" in tc
            ? { name: tc.function.name, args: tc.function.arguments.slice(0, 200) }
            : { name: tc.type },
        ),
        usage: result.value.usage,
      },
      "chat response",
    );
  } else {
    log.error({ error: String(result.error.message) }, "chat request failed");
  }

  return result;
}

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export function toOpenAITools(tools: ToolDefinition[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
