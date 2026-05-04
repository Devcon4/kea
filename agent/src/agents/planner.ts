import { Type } from "typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { z } from "zod";
import type { Browser } from "../browser/stagehand.js";
import { createLogger } from "../logger.js";
import type {
  CreateScenarioInput,
  DataStore,
  Feature,
  FeatureWithActivePlan,
  ScenarioStep,
  TestPlan,
} from "../memory/data-store.js";
import { bridgeSessionToStore } from "../pi/bridge.js";
import { createKeaSession } from "../pi/session.js";

type UrlPatternLike = {
  test(input: string): boolean;
};

declare const URLPattern: {
  new (input: string): UrlPatternLike;
};

const log = createLogger("planner");

const DISCOVER_TOOL_BUDGET = 6;
const AUTHOR_TOOL_BUDGET = 8;
const MAX_SCENARIOS_PER_PLAN = 3;
const MAX_STEPS_PER_SCENARIO = 6;
/**
 * Hard cap on revisions before the author abandons the feature and emits a
 * warning finding. Three attempts is enough room for the LLM to converge on a
 * runnable plan; beyond that the failure mode is usually not a plan-flaw any
 * single re-author can fix — it's a feature the model can't characterize from
 * what's on the page.
 */
const MAX_PLAN_REVISIONS = 3;

const DISCOVER_SYSTEM_PROMPT = `You are Kea's feature discovery specialist.

Goal: identify DISTINCT product capabilities (examples: login, checkout, search), not page-by-page fragments.

Rules:
- The user prompt lists the current URL, page title, and the same-origin URLs already known to exist. Treat that list as ground truth.
- urlPatterns on every record_feature call MUST match the current URL. Patterns that match no real URL are rejected.
- One feature may span many URLs. Use link_feature_url to attach more URLs after recording, instead of inventing wildcard patterns for paths that do not exist.
- Reuse existing features when they already represent the capability.
- Prefer reasoning from the URL list, page title, and known features. Use browser_observe / browser_extract ONLY when URL+title context is genuinely insufficient — each call burns budget.
- Stop once you have recorded all meaningful capabilities visible from this page.`;

const AUTHOR_SYSTEM_PROMPT = `You are Kea's test-plan authoring specialist.

Goal: author reproducible scenario plans for a single feature.

Rules:
- Produce at most 3 scenarios.
- Each scenario must have at most 6 steps.
- Prefer structured assertions (equal/regex). Use semantic assertions only when structured checks do not fit.
- Include verifyWith on every state-changing act step.
- Record scenarios via record_scenario and stop when done.

Step shapes (each step MUST set \"kind\" to one of these literals — not synonyms, not uppercase, not made-up names):
- { kind: "navigate", url: string }
- { kind: "act", instruction: string, verifyWith?: string }
- { kind: "observe", question: string, expect: { kind: "equal" | "regex" | "semantic", … } }
- { kind: "extract", instruction: string, schema: object, bind?: string, expect?: { … } }

Choosing the right expect.kind for observe:
- BOOLEAN questions ("is X visible?", "does Y exist?", "can the user Z?"): use { kind: "equal", value: true } or { kind: "equal", value: false }. The runner accepts yes/no/true/false answers.
- EXACT STRING match: use { kind: "equal", value: "<exact text>" } AND ask a question whose answer is that exact string (e.g. "what is the page title?" expect equal "Our Products"). NEVER pair a yes/no question with a string-valued equal.
- PATTERN match on a string answer: use { kind: "regex", pattern: "…", flags?: "i" } and ask for the literal text.
- OPEN-ENDED check that needs judgement: use { kind: "semantic", question: "…" }.

Examples:
- { "kind": "navigate", "url": "http://blog/posts.html" }
- { "kind": "act", "instruction": "click the first post link", "verifyWith": "the article body is visible" }
- { "kind": "observe", "question": "is the search input visible?", "expect": { "kind": "equal", "value": true } }
- { "kind": "observe", "question": "what is the page title?", "expect": { "kind": "equal", "value": "Our Products — Kea Shop" } }
- { "kind": "extract", "instruction": "the page title", "schema": { "title": "string" }, "expect": { "kind": "regex", "pattern": "^Kea" } }

Do NOT invent fields like action, stepId, step_number, kind="INPUT_ACTION", kind="NAVIGATE". The validator rejects them.`;

export type RunPlannerDiscoverInput = {
  url: string;
  browser: Browser;
  store: DataStore;
  sessionId: string;
};

export type RunPlannerDiscoverOutput = {
  featuresAdded: number;
  featuresLinked: number;
};

export type RunPlannerAuthorInput = {
  featureId: number;
  browser: Browser;
  store: DataStore;
};

export type RunPlannerAuthorOutput = {
  scenariosAdded: number;
  planRevision: number | null;
};

export type PlannerEvent =
  | {
      type: "tool_invocation";
      mode: "discover" | "author";
      tool: string;
      used: number;
      limit: number;
    }
  | {
      type: "budget_exhausted";
      mode: "discover" | "author";
      tool: string;
      used: number;
      limit: number;
    }
  | { type: "feature_created"; featureId: number; name: string }
  | { type: "feature_reused"; featureId: number; reason: "name" | "pattern-overlap" }
  | { type: "feature_linked"; featureId: number; url: string }
  | { type: "scenario_buffered"; name: string; count: number };

type BudgetState = {
  mode: "discover" | "author";
  limit: number;
  used: number;
  events: PlannerEvent[];
};

type DiscoverState = {
  featuresAdded: number;
  featuresLinked: number;
};

type AuthorState = {
  scenarios: CreateScenarioInput[];
};

function okResponse(
  message: string,
  details: Record<string, unknown>,
): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  return {
    content: [{ type: "text", text: message }],
    details: { ok: true, ...details },
  };
}

function failResponse(
  message: string,
  details: Record<string, unknown>,
): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  return {
    content: [{ type: "text", text: message }],
    details: { ok: false, ...details },
  };
}

function budgetResponse(
  state: BudgetState,
  tool: string,
): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  terminate: true;
} {
  state.events.push({
    type: "budget_exhausted",
    mode: state.mode,
    tool,
    used: state.used,
    limit: state.limit,
  });
  return {
    content: [{ type: "text", text: `budget exhausted after ${state.limit} tool calls` }],
    details: {
      ok: false,
      error: "budget exhausted",
      budgetExhausted: true,
      used: state.used,
      limit: state.limit,
    },
    terminate: true,
  };
}

function consumeBudget(state: BudgetState, tool: string): boolean {
  if (state.used >= state.limit) return false;
  state.used += 1;
  state.events.push({
    type: "tool_invocation",
    mode: state.mode,
    tool,
    used: state.used,
    limit: state.limit,
  });
  return true;
}

function toZodSchema(schema: unknown): z.ZodTypeAny {
  if (!isRecord(schema)) {
    return z.record(z.string(), z.unknown());
  }

  const typeValue = typeof schema.type === "string" ? schema.type : "object";
  if (typeValue === "string") return z.string();
  if (typeValue === "number") return z.number();
  if (typeValue === "integer") return z.number().int();
  if (typeValue === "boolean") return z.boolean();

  if (typeValue === "array") {
    return z.array(toZodSchema(schema.items));
  }

  const properties = isRecord(schema.properties) ? schema.properties : null;
  if (!properties) {
    return z.record(z.string(), z.unknown());
  }

  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : [],
  );

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, value] of Object.entries(properties)) {
    const field = toZodSchema(value);
    shape[key] = required.has(key) ? field : field.optional();
  }

  return z.object(shape).passthrough();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compileUrlPatterns(
  patterns: string[],
):
  | { ok: true; value: Array<{ source: string; compiled: UrlPatternLike }> }
  | { ok: false; error: string } {
  const out: Array<{ source: string; compiled: UrlPatternLike }> = [];
  for (const source of patterns) {
    try {
      out.push({ source, compiled: new URLPattern(source) });
    } catch {
      return { ok: false, error: `invalid URLPattern: ${source}` };
    }
  }
  return { ok: true, value: out };
}

function canParseUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function patternOverlapWithExisting(
  existing: FeatureWithActivePlan,
  incomingPatterns: Array<{ source: string; compiled: UrlPatternLike }>,
  contextUrl: string,
): boolean {
  for (const existingSource of existing.feature.urlPatterns) {
    let existingCompiled: UrlPatternLike;
    try {
      existingCompiled = new URLPattern(existingSource);
    } catch {
      continue;
    }

    for (const incoming of incomingPatterns) {
      if (incoming.source === existingSource) return true;
      if (incoming.compiled.test(contextUrl) && existingCompiled.test(contextUrl)) return true;
      if (canParseUrl(existingSource) && incoming.compiled.test(existingSource)) return true;
      if (canParseUrl(incoming.source) && existingCompiled.test(incoming.source)) return true;
    }
  }
  return false;
}

function resolveAuthorEntryUrl(feature: Feature): string | null {
  for (const pattern of feature.urlPatterns) {
    if (canParseUrl(pattern)) {
      return new URL(pattern).toString();
    }

    const prefix = pattern.match(/^https?:\/\/[^*]+/i)?.[0];
    if (!prefix) continue;

    const candidate = prefix.endsWith("/") ? prefix : `${prefix}/`;
    if (canParseUrl(candidate)) {
      return new URL(candidate).toString();
    }
  }
  return null;
}

const VALID_STEP_KINDS = ["navigate", "act", "observe", "extract"] as const;
type ValidStepKind = (typeof VALID_STEP_KINDS)[number];

/**
 * Yes/no question heads we recognize. The author prompt says never to pair a
 * yes/no question with a string-valued equal, but small models routinely
 * violate it. Catching the mismatch here forces a needs_revision turn so the
 * tester does not log false negatives like `expected "Article Title", got
 * "yes"`.
 */
const YES_NO_QUESTION_HEADS = /^\s*(is|are|am|was|were|do|does|did|has|have|had|can|could|should|would|will|may|might|must)\b/i;

function checkObservePairing(
  question: string,
  expectClause: Record<string, unknown>,
): { ok: true } | { ok: false; error: string } {
  if (expectClause.kind !== "equal") return { ok: true };
  const value = expectClause.value;
  const looksYesNo = YES_NO_QUESTION_HEADS.test(question);
  if (looksYesNo && typeof value === "string") {
    return {
      ok: false,
      error: `observe pairs a yes/no question ("${question.slice(0, 80)}") with expect.value of type string. Use { kind: "equal", value: true | false } for yes/no, or rephrase the question to ask for the literal text.`,
    };
  }
  if (!looksYesNo && typeof value === "boolean") {
    return {
      ok: false,
      error: `observe pairs a non-yes/no question ("${question.slice(0, 80)}") with expect.value boolean. Either rephrase the question as "is X visible?" or change expect.value to the literal string the answer should match.`,
    };
  }
  return { ok: true };
}

function normalizeScenarioSteps(
  raw: unknown,
): { ok: true; value: ScenarioStep[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "steps must be an array" };
  const parsed: ScenarioStep[] = [];
  for (let i = 0; i < raw.length; i++) {
    const step = raw[i];
    if (!isRecord(step) || typeof step.kind !== "string") {
      return {
        ok: false,
        error: `step[${i}] missing required string field "kind". Valid kinds: ${VALID_STEP_KINDS.join(", ")}.`,
      };
    }
    if (!(VALID_STEP_KINDS as readonly string[]).includes(step.kind)) {
      return {
        ok: false,
        error: `step[${i}].kind="${step.kind}" is not allowed. Valid kinds: ${VALID_STEP_KINDS.join(", ")}. ` +
          `Step shapes: navigate{url}, act{instruction,verifyWith?}, observe{question,expect}, extract{schema,bind?,expect?}.`,
      };
    }
    const kind = step.kind as ValidStepKind;
    if (kind === "navigate" && typeof step.url !== "string") {
      return { ok: false, error: `step[${i}] navigate requires string "url".` };
    }
    if (kind === "act" && typeof step.instruction !== "string") {
      return { ok: false, error: `step[${i}] act requires string "instruction".` };
    }
    if (kind === "observe" && (typeof step.question !== "string" || !isRecord(step.expect))) {
      return { ok: false, error: `step[${i}] observe requires "question" and "expect" object.` };
    }
    if (kind === "observe" && isRecord(step.expect)) {
      const pairing = checkObservePairing(
        typeof step.question === "string" ? step.question : "",
        step.expect,
      );
      if (!pairing.ok) {
        return { ok: false, error: `step[${i}] ${pairing.error}` };
      }
    }
    if (kind === "extract") {
      if (typeof step.instruction !== "string" || step.instruction.trim() === "") {
        return { ok: false, error: `step[${i}] extract requires non-empty "instruction" string.` };
      }
      if (!isRecord(step.schema)) {
        return { ok: false, error: `step[${i}] extract requires "schema" object.` };
      }
    }
    parsed.push(step as ScenarioStep);
  }
  return { ok: true, value: parsed };
}

function buildBrowserObserveTool(browser: Browser, budget: BudgetState): ToolDefinition {
  return defineTool({
    name: "browser_observe",
    label: "Browser observe",
    description: "Observe the current page for actions/elements relevant to a question.",
    parameters: Type.Object({
      question: Type.String({
        description: "Question to ask about what is available on the page.",
      }),
    }),
    execute: async (_id, { question }) => {
      if (!consumeBudget(budget, "browser_observe"))
        return budgetResponse(budget, "browser_observe");
      const observed = await browser.observe(question);
      if (!observed.ok) {
        return failResponse(`observe failed: ${observed.error.message}`, {
          error: observed.error.message,
        });
      }
      return okResponse(`observed ${observed.value.length} candidate action(s)`, {
        observed: observed.value,
      });
    },
  });
}

function buildBrowserExtractTool(browser: Browser, budget: BudgetState): ToolDefinition {
  return defineTool({
    name: "browser_extract",
    label: "Browser extract",
    description: "Extract structured data from the current page.",
    parameters: Type.Object({
      instruction: Type.String({ description: "Extraction instruction." }),
      schema: Type.Optional(
        Type.Object(
          {},
          {
            description: "JSON-schema-shaped extraction target.",
            additionalProperties: true,
          },
        ),
      ),
    }),
    execute: async (_id, { instruction, schema }) => {
      if (!consumeBudget(budget, "browser_extract"))
        return budgetResponse(budget, "browser_extract");
      const extracted = await browser.extract<Record<string, unknown>>(
        instruction,
        toZodSchema(schema ?? { type: "object" }),
      );
      if (!extracted.ok) {
        return failResponse(`extract failed: ${extracted.error.message}`, {
          error: extracted.error.message,
        });
      }
      return okResponse("extract succeeded", { extracted: extracted.value });
    },
  });
}

function buildDiscoverTools(
  input: RunPlannerDiscoverInput,
  state: DiscoverState,
  budget: BudgetState,
  contextUrl: string,
): ToolDefinition[] {
  const observe = buildBrowserObserveTool(input.browser, budget);
  const extract = buildBrowserExtractTool(input.browser, budget);

  const recordFeature = defineTool({
    name: "record_feature",
    label: "Record feature",
    description: "Create or reuse a feature for the current session.",
    parameters: Type.Object({
      name: Type.String({ description: "Stable feature name." }),
      description: Type.Optional(Type.String({ description: "Feature description." })),
      urlPatterns: Type.Array(Type.String({ description: "URLPattern source string." })),
    }),
    execute: async (_id, params) => {
      if (!consumeBudget(budget, "record_feature")) return budgetResponse(budget, "record_feature");

      const name = params.name.trim();
      const patterns = params.urlPatterns;
      if (!name) {
        return failResponse("feature name is required", { error: "missing name" });
      }
      if (!Array.isArray(patterns) || patterns.length === 0) {
        return failResponse("at least one URL pattern is required", {
          error: "missing urlPatterns",
        });
      }

      const compiledIncoming = compileUrlPatterns(patterns);
      if (!compiledIncoming.ok) {
        return failResponse(compiledIncoming.error, { error: compiledIncoming.error });
      }

      const matchesContext = compiledIncoming.value.some(({ compiled, source }) => {
        try {
          if (compiled.test(contextUrl)) return true;
        } catch {
          // ignore matcher errors; fall through
        }
        return source === contextUrl;
      });
      if (!matchesContext) {
        const text =
          `none of the urlPatterns ${JSON.stringify(patterns)} match the current URL ${contextUrl}. ` +
          `Patterns must match this page; use link_feature_url after recording to attach other URLs.`;
        return failResponse(text, {
          error: "pattern does not match context url",
          contextUrl,
          patterns,
        });
      }

      const listed = await input.store.listFeatures();
      if (!listed.ok) {
        return failResponse(`listFeatures failed: ${listed.error.message}`, {
          error: listed.error.message,
        });
      }

      const byName = listed.value.find(
        ({ feature }) => feature.name.trim().toLowerCase() === name.toLowerCase(),
      );
      if (byName) {
        budget.events.push({
          type: "feature_reused",
          featureId: byName.feature.id,
          reason: "name",
        });
        return okResponse("reused existing feature", {
          reused: true,
          reason: "name",
          featureId: byName.feature.id,
        });
      }

      const byPatternOverlap = listed.value.find((entry) =>
        patternOverlapWithExisting(entry, compiledIncoming.value, contextUrl),
      );
      if (byPatternOverlap) {
        log.warn(
          {
            featureId: byPatternOverlap.feature.id,
            name,
            incomingPatterns: patterns,
          },
          "feature URLPattern collision; reusing existing feature",
        );
        budget.events.push({
          type: "feature_reused",
          featureId: byPatternOverlap.feature.id,
          reason: "pattern-overlap",
        });
        return okResponse("reused existing feature", {
          reused: true,
          reason: "pattern-overlap",
          featureId: byPatternOverlap.feature.id,
        });
      }

      const created = await input.store.createFeature({
        name,
        description: params.description?.trim() ?? "",
        urlPatterns: patterns,
        discoveredBy: "planner",
      });
      if (!created.ok) {
        return failResponse(`createFeature failed: ${created.error.message}`, {
          error: created.error.message,
        });
      }

      state.featuresAdded += 1;
      budget.events.push({
        type: "feature_created",
        featureId: created.value.feature.id,
        name: created.value.feature.name,
      });

      return okResponse(`created feature ${created.value.feature.id}`, {
        reused: false,
        featureId: created.value.feature.id,
      });
    },
  });

  const linkFeatureUrl = defineTool({
    name: "link_feature_url",
    label: "Link feature URL",
    description: "Attach a concrete URL to an existing feature's URL patterns.",
    parameters: Type.Object({
      featureId: Type.Number({ description: "Feature id to update." }),
      url: Type.String({ description: "Concrete URL to attach." }),
    }),
    execute: async (_id, { featureId, url }) => {
      if (!consumeBudget(budget, "link_feature_url"))
        return budgetResponse(budget, "link_feature_url");

      let canonicalUrl: string;
      try {
        canonicalUrl = new URL(url).toString();
      } catch {
        return failResponse(`invalid URL: ${url}`, { error: `invalid URL: ${url}` });
      }

      const feature = await input.store.getFeature(featureId);
      if (!feature.ok) {
        return failResponse(`getFeature failed: ${feature.error.message}`, {
          error: feature.error.message,
          featureId,
        });
      }
      if (!feature.value) {
        return failResponse(`feature ${featureId} not found`, {
          error: "feature not found",
          featureId,
        });
      }

      const alreadyLinked = feature.value.feature.urlPatterns.some((patternSource) => {
        try {
          return new URLPattern(patternSource).test(canonicalUrl);
        } catch {
          return false;
        }
      });
      if (alreadyLinked || feature.value.feature.urlPatterns.includes(canonicalUrl)) {
        return okResponse("feature already linked to URL", {
          linked: false,
          featureId,
          url: canonicalUrl,
        });
      }

      const updated = await input.store.updateFeature(featureId, {
        urlPatterns: [...feature.value.feature.urlPatterns, canonicalUrl],
      });
      if (!updated.ok) {
        return failResponse(`updateFeature failed: ${updated.error.message}`, {
          error: updated.error.message,
          featureId,
        });
      }

      state.featuresLinked += 1;
      budget.events.push({ type: "feature_linked", featureId, url: canonicalUrl });

      return okResponse("linked feature URL", {
        linked: true,
        featureId,
        url: canonicalUrl,
      });
    },
  });

  return [observe, extract, recordFeature, linkFeatureUrl];
}

function buildAuthorTools(
  browser: Browser,
  budget: BudgetState,
  state: AuthorState,
): ToolDefinition[] {
  const observe = buildBrowserObserveTool(browser, budget);
  const extract = buildBrowserExtractTool(browser, budget);

  const recordScenario = defineTool({
    name: "record_scenario",
    label: "Record scenario",
    description:
      "Queue a scenario draft for this feature's next plan revision. Each step.kind must be exactly one of: navigate, act, observe, extract.",
    parameters: Type.Object({
      name: Type.String({ description: "Scenario name." }),
      entryUrl: Type.String({ description: "Scenario entry URL." }),
      steps: Type.Array(
        Type.Object({}, { additionalProperties: true, description: "Scenario step objects." }),
      ),
      expectedOutcome: Type.String({ description: "Expected final outcome." }),
    }),
    execute: async (_id, params) => {
      if (!consumeBudget(budget, "record_scenario"))
        return budgetResponse(budget, "record_scenario");

      if (state.scenarios.length >= MAX_SCENARIOS_PER_PLAN) {
        return failResponse(`scenario cap exceeded (${MAX_SCENARIOS_PER_PLAN})`, {
          error: "scenario cap exceeded",
          max: MAX_SCENARIOS_PER_PLAN,
        });
      }

      const name = params.name.trim();
      const expectedOutcome = params.expectedOutcome.trim();
      if (!name || !expectedOutcome) {
        return failResponse("scenario name and expectedOutcome are required", {
          error: "invalid scenario metadata",
        });
      }

      try {
        new URL(params.entryUrl);
      } catch {
        return failResponse(`invalid entryUrl: ${params.entryUrl}`, {
          error: `invalid entryUrl: ${params.entryUrl}`,
        });
      }

      const normalized = normalizeScenarioSteps(params.steps);
      if (!normalized.ok) {
        return failResponse(normalized.error, { error: normalized.error });
      }
      if (normalized.value.length === 0) {
        return failResponse("scenario requires at least one step", {
          error: "missing steps",
        });
      }
      if (normalized.value.length > MAX_STEPS_PER_SCENARIO) {
        return failResponse(`step cap exceeded (${MAX_STEPS_PER_SCENARIO})`, {
          error: "step cap exceeded",
          max: MAX_STEPS_PER_SCENARIO,
        });
      }

      state.scenarios.push({
        name,
        entryUrl: params.entryUrl,
        steps: normalized.value,
        expectedOutcome,
      });
      budget.events.push({
        type: "scenario_buffered",
        name,
        count: state.scenarios.length,
      });

      return okResponse(`queued scenario ${state.scenarios.length}`, {
        count: state.scenarios.length,
      });
    },
  });

  return [observe, extract, recordScenario];
}

/**
 * Per FDD-0009 budget requirement, planner-discover has a hard per-run cap.
 * The cap is enforced at tool-call time so over-budget calls produce explicit
 * structured results instead of exceptions.
 */
export async function runPlannerDiscover(
  input: RunPlannerDiscoverInput,
): Promise<RunPlannerDiscoverOutput> {
  const state: DiscoverState = { featuresAdded: 0, featuresLinked: 0 };
  let kea: Awaited<ReturnType<typeof createKeaSession>> | null = null;
  let unbridge: (() => void) | null = null;

  try {
    const nav = await input.browser.navigate(input.url);
    if (!nav.ok) {
      log.warn({ url: input.url, err: nav.error.message }, "planner discover navigation failed");
      return { featuresAdded: 0, featuresLinked: 0 };
    }

    const budget: BudgetState = {
      mode: "discover",
      limit: DISCOVER_TOOL_BUDGET,
      used: 0,
      events: [],
    };

    const tools = buildDiscoverTools(input, state, budget, nav.value.url);
    kea = await createKeaSession({
      role: "planner-discover",
      tools,
      systemPrompt: DISCOVER_SYSTEM_PROMPT,
      disableRetry: false,
    });

    unbridge = bridgeSessionToStore(kea.session, "planner-discover", input.store);

    const knownFeatures = await input.store.listFeatures();
    const featureList = knownFeatures.ok
      ? knownFeatures.value
          .slice(0, 20)
          .map(({ feature }) => `${feature.id}:${feature.name}`)
          .join(", ")
      : "unavailable";

    let originUrls: string[] = [];
    try {
      const knownPages = await input.store.getAllPages();
      if (knownPages?.ok) {
        const origin = new URL(nav.value.url).origin;
        originUrls = knownPages.value
          .map((p) => p.url)
          .filter((u) => {
            try {
              return new URL(u).origin === origin;
            } catch {
              return false;
            }
          });
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "planner discover: getAllPages unavailable; proceeding without sitemap context",
      );
    }
    const urlList = originUrls.length
      ? originUrls.slice(0, 30).join(", ")
      : "(none recorded yet)";

    const userPrompt = [
      `Session: ${input.sessionId}`,
      `Start URL: ${input.url}`,
      `Resolved URL: ${nav.value.url}`,
      `Page title: ${nav.value.title}`,
      `Same-origin URLs in sitemap (${originUrls.length}): ${urlList}`,
      `Known features: ${featureList}`,
      "Discover product capabilities and record them. Patterns must match the current URL.",
    ].join("\n");

    await kea.session.prompt(userPrompt);

    return {
      featuresAdded: state.featuresAdded,
      featuresLinked: state.featuresLinked,
    };
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), url: input.url },
      "planner discover failed",
    );
    return { featuresAdded: 0, featuresLinked: 0 };
  } finally {
    if (unbridge) unbridge();
    if (kea) kea.dispose();
  }
}

/**
 * Per FDD-0009 budget requirement, planner-author has its own hard cap and
 * must return partial authored scenarios instead of throwing.
 */
export async function runPlannerAuthor(
  input: RunPlannerAuthorInput,
): Promise<RunPlannerAuthorOutput> {
  let kea: Awaited<ReturnType<typeof createKeaSession>> | null = null;
  let unbridge: (() => void) | null = null;

  try {
    const feature = await input.store.getFeature(input.featureId);
    if (!feature.ok) {
      log.warn(
        { featureId: input.featureId, err: feature.error.message },
        "planner author failed to load feature",
      );
      return { scenariosAdded: 0, planRevision: null };
    }
    if (!feature.value) {
      log.warn({ featureId: input.featureId }, "planner author feature not found");
      return { scenariosAdded: 0, planRevision: null };
    }

    if (feature.value.activePlan) {
      return {
        scenariosAdded: 0,
        planRevision: feature.value.activePlan.plan.revision,
      };
    }

    // Identify the most recent prior plan and the highest revision number used
    // for this feature. A plan in `needs_revision` carries the tester's verdict;
    // we feed it to the author session as concrete diagnosis. The cap below uses
    // the highest existing revision so a feature can never accumulate more than
    // MAX_REVISIONS attempts in a single session.
    const orderedRevisions = [...feature.value.revisions].sort(
      (a, b) => b.plan.revision - a.plan.revision,
    );
    const priorPlan = orderedRevisions[0]?.plan ?? null;
    const highestRevision = priorPlan?.revision ?? 0;

    if (highestRevision >= MAX_PLAN_REVISIONS) {
      log.warn(
        {
          featureId: input.featureId,
          highestRevision,
          max: MAX_PLAN_REVISIONS,
        },
        "planner author hit revision cap; retiring feature",
      );
      const reason = priorPlan?.revisionFeedback?.reason ?? "other";
      const diagnosis = priorPlan?.revisionFeedback?.diagnosis ?? "(no prior diagnosis)";
      const probeUrl = resolveAuthorEntryUrl(feature.value.feature);
      // Retire the feature so the coordinator's planless backlog drops it,
      // preventing the loop where author_plan keeps being re-issued and the
      // same warning piles up across turns. The retire is the canonical
      // "we tried, give up" signal — recoverable only via explicit human
      // re-activation.
      const retired = await input.store.updateFeature(input.featureId, {
        status: "retired",
        verifiedAt: Date.now(),
      });
      if (!retired.ok) {
        log.warn(
          { featureId: input.featureId, err: retired.error.message },
          "failed to retire feature after revision cap",
        );
      }
      // Emit the abandonment finding only when this turn is the one that
      // moved the feature into `retired`. If the feature was already
      // retired (e.g. an out-of-band revalidate_feature that re-entered
      // this branch), don't double-record.
      const wasActive = feature.value.feature.status === "active";
      if (wasActive) {
        await input.store.addFinding({
          url: probeUrl ?? feature.value.feature.urlPatterns[0] ?? "about:blank",
          agentId: "planner-author",
          action: `feature "${feature.value.feature.name}" abandoned after ${MAX_PLAN_REVISIONS} revisions`,
          result:
            `Author could not produce a runnable plan after ${MAX_PLAN_REVISIONS} attempts. ` +
            `Last verdict reason: ${reason}. Last diagnosis: ${diagnosis}`,
          severity: "warning",
          timestamp: Date.now(),
        });
      }
      return { scenariosAdded: 0, planRevision: highestRevision };
    }

    const entryUrl = resolveAuthorEntryUrl(feature.value.feature);
    if (!entryUrl) {
      log.warn(
        { featureId: input.featureId },
        "planner author could not resolve feature entry URL",
      );
      return { scenariosAdded: 0, planRevision: null };
    }

    const nav = await input.browser.navigate(entryUrl);
    if (!nav.ok) {
      log.warn(
        { featureId: input.featureId, entryUrl, err: nav.error.message },
        "planner author navigation failed",
      );
      return { scenariosAdded: 0, planRevision: null };
    }

    const authorState: AuthorState = { scenarios: [] };
    const budget: BudgetState = {
      mode: "author",
      limit: AUTHOR_TOOL_BUDGET,
      used: 0,
      events: [],
    };

    const tools = buildAuthorTools(input.browser, budget, authorState);
    kea = await createKeaSession({
      role: "planner-author",
      tools,
      systemPrompt: AUTHOR_SYSTEM_PROMPT,
      disableRetry: false,
    });

    unbridge = bridgeSessionToStore(kea.session, "planner-author", input.store);

    const userPrompt = [
      `Feature ID: ${feature.value.feature.id}`,
      `Feature name: ${feature.value.feature.name}`,
      `Feature description: ${feature.value.feature.description}`,
      `Feature URL patterns: ${JSON.stringify(feature.value.feature.urlPatterns)}`,
      `Resolved entry URL: ${nav.value.url}`,
      `Page title: ${nav.value.title}`,
      ...renderRevisionFeedback(priorPlan),
      "Author reproducible scenarios and record them.",
    ].join("\n");

    await kea.session.prompt(userPrompt);

    if (authorState.scenarios.length === 0) {
      return { scenariosAdded: 0, planRevision: null };
    }

    const stored = await input.store.addTestPlan(input.featureId, {
      createdBy: "planner",
      scenarios: authorState.scenarios,
    });
    if (!stored.ok) {
      log.warn(
        { featureId: input.featureId, err: stored.error.message },
        "planner author failed to store test plan",
      );
      return { scenariosAdded: 0, planRevision: null };
    }

    return {
      scenariosAdded: stored.value.scenarios.length,
      planRevision: stored.value.plan.revision,
    };
  } catch (err) {
    log.warn(
      { featureId: input.featureId, err: err instanceof Error ? err.message : String(err) },
      "planner author failed",
    );
    return { scenariosAdded: 0, planRevision: null };
  } finally {
    if (unbridge) unbridge();
    if (kea) kea.dispose();
  }
}


/**
 * Render prior plan feedback as user-prompt context for the author session.
 * Returns an empty array when there is no `needs_revision` feedback to surface
 * — the author run starts cold rather than being given an empty bullet list.
 */
function renderRevisionFeedback(priorPlan: TestPlan | null): string[] {
  if (!priorPlan || priorPlan.status !== "needs_revision" || !priorPlan.revisionFeedback) {
    return [];
  }
  const fb = priorPlan.revisionFeedback;
  return [
    "",
    `Prior plan revision ${priorPlan.revision} was rejected as scenario-flawed.`,
    `  Reason: ${fb.reason}`,
    `  Failing step #${fb.failingStepIndex} evidence: ${fb.failingStepEvidence}`,
    `  Diagnosis: ${fb.diagnosis}`,
    "Author a NEW plan that avoids the same flaw class. Do not re-emit the failing step shape.",
  ];
}
