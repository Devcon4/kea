import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { z } from "zod";
import type {
  ExpectClause,
  RevisionFeedback,
  RevisionFeedbackReason,
  RunDiagnostics,
  Scenario,
  ScenarioStep,
  StepTraceEntry,
  TestRunResult,
} from "@kea/shared";
import type { Browser } from "../browser/stagehand.js";
import type { DataStore, Severity } from "../memory/data-store.js";
import { createLogger } from "../logger.js";
import { createKeaSession } from "../pi/session.js";

const log = createLogger("tester");

const MAX_SCENARIO_STEPS = 8;
const MAX_PAGE_TRANSITIONS = 5;
const OBSERVE_ANSWER_SCHEMA = z.object({ answer: z.string() });
const FALLBACK_EXTRACT_SCHEMA = z.record(z.string(), z.unknown());

export type SemanticJudgeInput = {
  question: string;
  answer: string;
  scenario: Scenario;
  stepIndex: number;
  sessionId: string | null;
};

export type SemanticJudge = (input: SemanticJudgeInput) => Promise<boolean>;

export type ObserverInput = {
  question: string;
  pageUrl: string;
  pageTitle: string;
  pageText: string;
  scenario: Scenario;
  stepIndex: number;
  sessionId: string | null;
};

/**
 * Observer answers an observe step's question against the current page. The
 * default implementation drives a Pi tool-call session against the visible
 * DOM text — it deliberately bypasses Stagehand's structured-output extract
 * because llama.cpp / Ollama frequently fails to load the JSON-schema grammar
 * for small models, surfacing as `"failed to load model vocabulary required
 * for format"` and turning every observe into a false-negative test failure.
 * Tool calls (yes/no/answer) are reliable across models because they don't
 * require the model to emit grammar-constrained JSON.
 */
export type Observer = (
  input: ObserverInput,
) => Promise<{ ok: true; answer: string } | { ok: false; error: string }>;

/**
 * Verdict on a non-passing scenario run. `product_failure` means the system
 * under test is broken and the failure should surface as a finding.
 * `scenario_flawed` means the plan itself is wrong (ambiguous instruction,
 * impossible assertion, missing element…) and the plan should flip to
 * `needs_revision` so the next coordinator turn re-authors it.
 */
export type FlawJudgeVerdict =
  | { kind: "product_failure" }
  | {
      kind: "scenario_flawed";
      reason: RevisionFeedbackReason;
      diagnosis: string;
    };

export type FlawJudgeInput = {
  scenario: Scenario;
  failingStep: StepTraceEntry;
  failingEvidence: string;
  failingUrl: string | null;
  pageTitle: string | null;
  pageDomSnippet: string | null;
  sessionId: string | null;
};

export type FlawJudge = (input: FlawJudgeInput) => Promise<FlawJudgeVerdict>;

export type RunTesterInput = {
  scenario: Scenario;
  browser: Browser;
  store: DataStore;
  judge?: SemanticJudge;
  /**
   * Optional classifier invoked when a scenario fails or errors. When set, a
   * `scenario_flawed` verdict marks the plan `needs_revision` (with feedback)
   * and suppresses the would-be finding. When omitted, every fail/error
   * surfaces as a finding (legacy behavior; used by unit tests).
   */
  flawJudge?: FlawJudge;
  /**
   * Optional override for the observe step's question-answering. Defaults to
   * `defaultObserver`, which extracts visible page text and asks the LLM via
   * a tool-call session. Tests inject a deterministic Observer to avoid LLM
   * dependency.
   */
  observer?: Observer;
  sessionId?: string;
};

export type RunTesterOutput = {
  result: TestRunResult;
  runId: number | null;
  findingId: number | null;
};

/**
 * Execute one feature-driven Scenario with a deterministic step interpreter and
 * persist the resulting TestRun, per
 * [FDD-0010](../../../docs/fdd/0010-feature-driven-test-planning.md) and
 * [ADR-024](../../../docs/adr/024-features-as-canonical-spec.md).
 */
export async function runTester(input: RunTesterInput): Promise<RunTesterOutput> {
  return runScenarioTester(input);
}

type StepDispatchResult = {
  result: "pass" | "fail" | "error";
  evidence: string;
  urlHint?: string;
  binding?: { name: string; value: unknown };
  /** Set on failure when the step compared an expected vs observed value (observe/extract+expect). */
  expected?: unknown;
  observed?: unknown;
};

async function runScenarioTester(input: RunTesterInput): Promise<RunTesterOutput> {
  const startedAt = Date.now();
  const stepTrace: StepTraceEntry[] = [];
  const bindings: Record<string, unknown> = {};
  const judge = input.judge ?? defaultSemanticJudge;
  const observer = input.observer ?? defaultObserver;
  const sessionId = resolveSessionId(input.sessionId, input.store);

  // Diagnostic buffers (console/page errors/network failures) accumulate
  // inside the Browser; reset before every scenario so a noisy earlier
  // run doesn't bleed into a later failure's evidence.
  await input.browser.resetDiagnostics();

  let runResult: TestRunResult = "pass";
  let currentUrl = input.scenario.entryUrl;
  let transitionCount = 0;
  let failingStep: StepTraceEntry | null = null;
  let failingEvidence: string | null = null;
  let failingUrl: string | null = null;
  let failingExpected: unknown = undefined;
  let failingObserved: unknown = undefined;

  if (input.scenario.steps.length > MAX_SCENARIO_STEPS) {
    runResult = "error";
    failingEvidence = "scenario step cap exceeded";
  }

  if (runResult !== "error") {
    for (const [offset, step] of input.scenario.steps.entries()) {
      const index = offset + 1;
      const args = prepareStepArgs(step, bindings);
      const stepStartedAt = Date.now();

      try {
        const dispatchResult = await dispatchStep({
          scenario: input.scenario,
          step,
          index,
          args,
          browser: input.browser,
          judge,
          observer,
          sessionId,
          currentUrl,
          registerTransition: () => {
            transitionCount += 1;
            if (transitionCount <= MAX_PAGE_TRANSITIONS) return null;
            return "page transition cap exceeded";
          },
        });

        const traceEntry: StepTraceEntry = {
          index,
          kind: step.kind,
          args,
          result: dispatchResult.result,
          evidence: dispatchResult.evidence,
          latencyMs: Date.now() - stepStartedAt,
        };
        stepTrace.push(traceEntry);

        if (dispatchResult.binding) {
          bindings[dispatchResult.binding.name] = dispatchResult.binding.value;
        }

        if (dispatchResult.urlHint) {
          currentUrl = dispatchResult.urlHint;
        }

        if (dispatchResult.result === "pass") {
          continue;
        }

        runResult = dispatchResult.result === "error" ? "error" : "fail";
        failingStep = traceEntry;
        failingEvidence = traceEntry.evidence;
        failingUrl = dispatchResult.urlHint ?? currentUrl;
        failingExpected = dispatchResult.expected;
        failingObserved = dispatchResult.observed;
        break;
      } catch (err) {
        const message = toErrorMessage(err);
        const traceEntry: StepTraceEntry = {
          index,
          kind: step.kind,
          args,
          result: "error",
          evidence: message,
          latencyMs: Date.now() - stepStartedAt,
        };
        stepTrace.push(traceEntry);
        runResult = "error";
        failingStep = traceEntry;
        failingEvidence = message;
        failingUrl = currentUrl;
        break;
      }
    }
  }

  // Classify a non-passing run before deciding whether to emit a finding.
  // When the judge calls scenario_flawed and the API accepts the transition, we
  // route diagnosis into the plan via revision_feedback and suppress the
  // would-be finding — a flawed scenario isn't a product defect, and recording
  // it as one trains the dashboard to lie. When the API rejects the transition
  // (race, or plan no longer active) we fall back to the finding so the failure
  // is not silently swallowed.
  const flaw = await classifyScenarioFlaw({
    runResult,
    failingStep,
    failingEvidence,
    failingUrl,
    flawJudge: input.flawJudge,
    scenario: input.scenario,
    sessionId,
  });

  const findingId = flaw
    ? null
    : await maybeCreateFinding({
        store: input.store,
        scenario: input.scenario,
        result: runResult,
        failingStep,
        fallbackEvidence: failingEvidence,
        failingUrl,
      });

  // Capture failure-time browser diagnostics before the next scenario
  // resets the buffers. Only fail/error runs carry diagnostics — a passing
  // run with a screenshot would be a contract violation the API rejects.
  let diagnostics: RunDiagnostics | null = null;
  let screenshot: Buffer | null = null;
  if (runResult === "fail" || runResult === "error") {
    const captured = await input.browser.captureDiagnostics({
      failingStepIndex: failingStep ? failingStep.index : null,
      expected: failingExpected,
      observed: failingObserved,
    });
    if (captured.ok) {
      diagnostics = captured.value.diagnostics;
      screenshot = captured.value.screenshot;
    } else {
      log.warn(
        { scenarioId: input.scenario.id, error: captured.error.message },
        "failed to capture diagnostics",
      );
    }
  }

  const completedAt = Date.now();
  const runRecord = await input.store.recordTestRun(input.scenario.id, {
    startedAt,
    completedAt,
    result: runResult,
    stepTrace,
    findingId,
    diagnostics,
  });

  if (!runRecord.ok) {
    log.warn(
      {
        scenarioId: input.scenario.id,
        error: runRecord.error.message,
      },
      "failed to persist test run",
    );
    return {
      result: runResult,
      runId: null,
      findingId,
    };
  }

  // Persist the verdict to the plan only after the run row exists, so the
  // captured `rejectedByRunId` reflects the run that actually triggered it.
  // The marker is best-effort: if the API rejects the transition (e.g. plan
  // already superseded) we log and move on — the run is recorded either way.
  if (flaw) {
    const feedback: RevisionFeedback = {
      rejectedAt: completedAt,
      rejectedByRunId: runRecord.value.id,
      reason: flaw.reason,
      diagnosis: flaw.diagnosis,
      failingStepIndex: flaw.failingStepIndex,
      failingStepEvidence: flaw.failingStepEvidence,
    };
    const marked = await input.store.markPlanNeedsRevision(
      input.scenario.testPlanId,
      feedback,
    );
    if (!marked.ok) {
      log.warn(
        {
          scenarioId: input.scenario.id,
          planId: input.scenario.testPlanId,
          error: marked.error.message,
        },
        "failed to mark plan needs_revision",
      );
    }
  }

  // Upload the screenshot under the run id we just got back. Best-effort —
  // a missing screenshot reduces evidence quality but does not invalidate
  // the run record itself.
  if (screenshot) {
    const upload = await input.store.uploadTestRunArtifact({
      testRunId: runRecord.value.id,
      kind: "screenshot",
      contentType: "image/png",
      bytes: screenshot,
    });
    if (!upload.ok) {
      log.warn(
        { runId: runRecord.value.id, error: upload.error.message },
        "failed to upload run screenshot",
      );
    }
  }

  return {
    result: runResult,
    runId: runRecord.value.id,
    findingId,
  };
}

async function dispatchStep(input: {
  scenario: Scenario;
  step: ScenarioStep;
  index: number;
  args: Record<string, unknown>;
  browser: Browser;
  judge: SemanticJudge;
  observer: Observer;
  sessionId: string | null;
  currentUrl: string;
  registerTransition: () => string | null;
}): Promise<StepDispatchResult> {
  if (input.step.kind === "navigate") {
    const url = asString(input.args.url);
    if (!url) {
      return { result: "fail", evidence: "navigate.url must be a non-empty string" };
    }

    const nav = await input.browser.navigate(url);
    if (!nav.ok) {
      return {
        result: "fail",
        evidence: `navigate failed: ${nav.error.message}`,
        urlHint: url,
      };
    }

    const transitionCapError = input.registerTransition();
    if (transitionCapError) {
      return {
        result: "error",
        evidence: transitionCapError,
        urlHint: nav.value.url || url,
      };
    }

    return {
      result: "pass",
      evidence: safeJson(nav.value),
      urlHint: nav.value.url || url,
    };
  }

  if (input.step.kind === "act") {
    const instruction = asString(input.args.instruction);
    if (!instruction) {
      return { result: "fail", evidence: "act.instruction must be a non-empty string" };
    }

    const verifyWith = asOptionalString(input.args.verifyWith);

    const firstAttempt = await runActAttempt({
      browser: input.browser,
      instruction,
      currentUrl: input.currentUrl,
      registerTransition: input.registerTransition,
    });
    if (firstAttempt.result === "error") {
      return firstAttempt;
    }

    if (firstAttempt.result === "pass") {
      return verifyActOutcome({
        browser: input.browser,
        verifyWith,
        urlHint: firstAttempt.urlHint,
        successEvidence: firstAttempt.evidence,
      });
    }

    const retryInstruction = `Try a different approach: ${instruction}`;
    const retryAttempt = await runActAttempt({
      browser: input.browser,
      instruction: retryInstruction,
      currentUrl: firstAttempt.urlHint ?? input.currentUrl,
      registerTransition: input.registerTransition,
    });
    if (retryAttempt.result === "error") {
      return retryAttempt;
    }

    if (retryAttempt.result === "pass") {
      return verifyActOutcome({
        browser: input.browser,
        verifyWith,
        urlHint: retryAttempt.urlHint,
        successEvidence: `retried once and succeeded: ${retryAttempt.evidence}`,
      });
    }

    return {
      result: "fail",
      evidence: `act failed after retry: ${retryAttempt.evidence}`,
      urlHint: retryAttempt.urlHint ?? firstAttempt.urlHint,
    };
  }

  if (input.step.kind === "observe") {
    const question = asString(input.args.question);
    if (!question) {
      return { result: "fail", evidence: "observe.question must be a non-empty string" };
    }

    const expectClause = input.args.expect as ExpectClause;
    const context = await captureObserveContext(input.browser, input.currentUrl);
    const observed = await input.observer({
      question,
      pageUrl: context.url,
      pageTitle: context.title,
      pageText: context.text,
      scenario: input.scenario,
      stepIndex: input.index,
      sessionId: input.sessionId,
    });
    if (!observed.ok) {
      return {
        result: "fail",
        evidence: `observe failed: ${observed.error}`,
        urlHint: input.currentUrl,
      };
    }

    const answer = observed.answer;
    const expectation = await evaluateExpectation({
      expectClause,
      answer,
      judge: input.judge,
      scenario: input.scenario,
      stepIndex: input.index,
      sessionId: input.sessionId,
    });

    if (!expectation.pass) {
      return {
        result: "fail",
        evidence: `observe assertion failed: ${expectation.evidence}`,
        urlHint: input.currentUrl,
        expected: expectation.expected,
        observed: expectation.observed,
      };
    }

    return {
      result: "pass",
      evidence: `observe answer: ${answer}`,
      urlHint: input.currentUrl,
    };
  }

  const instruction = asString(input.args.instruction);
  if (!instruction) {
    return { result: "fail", evidence: "extract.instruction must be a non-empty string" };
  }
  const schema = isRecord(input.args.schema) ? input.args.schema : {};
  const zodSchema = toZodSchema(schema);
  const extracted = await input.browser.extract(instruction, zodSchema);
  if (!extracted.ok) {
    return {
      result: "fail",
      evidence: `extract failed: ${extracted.error.message}`,
      urlHint: input.currentUrl,
    };
  }

  const extractedValue = extracted.value;
  const bindName = asOptionalString(input.args.bind);
  const expectClause = input.args.expect as ExpectClause | undefined;

  if (expectClause) {
    const expectation = await evaluateExpectation({
      expectClause,
      answer: extractedValue,
      judge: input.judge,
      scenario: input.scenario,
      stepIndex: input.index,
      sessionId: input.sessionId,
    });

    if (!expectation.pass) {
      return {
        result: "fail",
        evidence: `extract assertion failed: ${expectation.evidence}`,
        urlHint: input.currentUrl,
        expected: expectation.expected,
        observed: expectation.observed,
      };
    }
  }

  const success: StepDispatchResult = {
    result: "pass",
    evidence: `extract value: ${safeJson(extractedValue)}`,
    urlHint: input.currentUrl,
  };

  if (bindName) {
    success.binding = { name: bindName, value: extractedValue };
  }

  return success;
}

async function runActAttempt(input: {
  browser: Browser;
  instruction: string;
  currentUrl: string;
  registerTransition: () => string | null;
}): Promise<StepDispatchResult> {
  const beforeUrl = readCurrentUrl(input.browser, input.currentUrl);
  const acted = await input.browser.act(input.instruction);
  const afterUrl = readCurrentUrl(input.browser, beforeUrl);

  if (afterUrl !== beforeUrl) {
    const capError = input.registerTransition();
    if (capError) {
      return {
        result: "error",
        evidence: capError,
        urlHint: afterUrl,
      };
    }
  }

  if (!acted.ok) {
    return {
      result: "fail",
      evidence: acted.error.message,
      urlHint: afterUrl,
    };
  }

  if (!acted.value.success) {
    return {
      result: "fail",
      evidence: acted.value.description || "act reported unsuccessful",
      urlHint: afterUrl,
    };
  }

  return {
    result: "pass",
    evidence: acted.value.description || "act succeeded",
    urlHint: afterUrl,
  };
}

async function verifyActOutcome(input: {
  browser: Browser;
  verifyWith?: string;
  urlHint?: string;
  successEvidence: string;
}): Promise<StepDispatchResult> {
  if (!input.verifyWith) {
    return {
      result: "pass",
      evidence: input.successEvidence,
      urlHint: input.urlHint,
    };
  }

  const verify = await input.browser.extract<{ answer: string }>(
    input.verifyWith,
    OBSERVE_ANSWER_SCHEMA,
  );
  if (!verify.ok) {
    return {
      result: "fail",
      evidence: `verifyWith failed: ${verify.error.message}`,
      urlHint: input.urlHint,
    };
  }

  const answer = verify.value.answer;
  if (!isYesAnswer(answer)) {
    return {
      result: "fail",
      evidence: `verifyWith answered '${answer}', expected yes`,
      urlHint: input.urlHint,
    };
  }

  return {
    result: "pass",
    evidence: `${input.successEvidence}; verifyWith answered yes`,
    urlHint: input.urlHint,
  };
}

async function evaluateExpectation(input: {
  expectClause: ExpectClause;
  answer: unknown;
  judge: SemanticJudge;
  scenario: Scenario;
  stepIndex: number;
  sessionId: string | null;
}): Promise<{ pass: boolean; evidence: string; expected?: unknown; observed?: unknown }> {
  if (input.expectClause.kind === "equal") {
    const expected = input.expectClause.value;
    const coerced = coerceForEqual(input.answer, expected);
    const pass = isDeepStrictEqual(coerced, expected);
    if (pass) {
      return { pass: true, evidence: "equal assertion passed" };
    }

    return {
      pass: false,
      evidence: `expected ${safeJson(expected)}, got ${safeJson(input.answer)}`,
      expected,
      observed: input.answer,
    };
  }

  if (input.expectClause.kind === "regex") {
    if (typeof input.answer !== "string") {
      return {
        pass: false,
        evidence: `regex assertion expects string answer, got ${typeof input.answer}`,
        expected: { regex: input.expectClause.pattern, flags: input.expectClause.flags },
        observed: input.answer,
      };
    }

    const regex = new RegExp(input.expectClause.pattern, input.expectClause.flags);
    const pass = regex.test(input.answer);
    if (pass) {
      return { pass: true, evidence: "regex assertion passed" };
    }

    return {
      pass: false,
      evidence: `regex /${input.expectClause.pattern}/${input.expectClause.flags ?? ""} did not match '${input.answer}'`,
      expected: { regex: input.expectClause.pattern, flags: input.expectClause.flags },
      observed: input.answer,
    };
  }

  const answerText = typeof input.answer === "string" ? input.answer : safeJson(input.answer);
  const pass = await input.judge({
    question: input.expectClause.question,
    answer: answerText,
    scenario: input.scenario,
    stepIndex: input.stepIndex,
    sessionId: input.sessionId,
  });
  if (pass) {
    return { pass: true, evidence: "semantic assertion passed" };
  }

  return {
    pass: false,
    evidence: `semantic assertion failed for answer '${answerText}'`,
    expected: { semantic: input.expectClause.question },
    observed: answerText,
  };
}

async function maybeCreateFinding(input: {
  store: DataStore;
  scenario: Scenario;
  result: TestRunResult;
  failingStep: StepTraceEntry | null;
  fallbackEvidence: string | null;
  failingUrl: string | null;
}): Promise<number | null> {
  if (input.result === "pass") return null;
  if (input.result === "skipped") return null;

  const severity: Severity = input.result === "fail" ? "error" : "warning";
  const evidence =
    input.failingStep?.evidence ?? input.fallbackEvidence ?? "scenario failed without trace";
  const stepPrefix = input.failingStep ? `step ${input.failingStep.index}: ` : "";
  const finding = await input.store.addFinding({
    url: input.failingUrl ?? input.scenario.entryUrl,
    agentId: "tester",
    action: input.scenario.name,
    result: `${stepPrefix}${evidence}`,
    severity,
    timestamp: Date.now(),
    scenarioId: input.scenario.id,
  });

  if (!finding.ok) {
    log.warn(
      {
        scenarioId: input.scenario.id,
        error: finding.error.message,
      },
      "failed to persist tester finding",
    );
    return null;
  }

  return finding.value;
}

function prepareStepArgs(
  step: ScenarioStep,
  bindings: Record<string, unknown>,
): Record<string, unknown> {
  if (step.kind === "navigate") {
    return {
      url: substituteUnknown(step.url, bindings),
    };
  }

  if (step.kind === "act") {
    const args: Record<string, unknown> = {
      instruction: substituteUnknown(step.instruction, bindings),
    };
    if (step.verifyWith !== undefined) {
      args.verifyWith = substituteUnknown(step.verifyWith, bindings);
    }
    return args;
  }

  if (step.kind === "observe") {
    return {
      question: substituteUnknown(step.question, bindings),
      expect: substituteUnknown(step.expect, bindings),
    };
  }

  const args: Record<string, unknown> = {
    instruction: substituteUnknown(step.instruction, bindings),
    schema: step.schema,
  };
  if (step.bind !== undefined) {
    args.bind = substituteUnknown(step.bind, bindings);
  }
  if (step.expect !== undefined) {
    args.expect = substituteUnknown(step.expect, bindings);
  }
  return args;
}

function substituteUnknown(value: unknown, bindings: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (match, name) => {
      if (!(name in bindings)) return match;
      return bindingValueToString(bindings[name]);
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => substituteUnknown(item, bindings));
  }

  if (!isRecord(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = substituteUnknown(item, bindings);
  }
  return out;
}

function bindingValueToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null) return "null";
  return safeJson(value);
}

function toZodSchema(schema: Record<string, unknown>): z.ZodTypeAny {
  const converted = convertJsonSchema(schema);
  if (converted) return converted;
  return FALLBACK_EXTRACT_SCHEMA;
}

function convertJsonSchema(schema: unknown): z.ZodTypeAny | null {
  if (!isRecord(schema)) return null;

  if (Array.isArray(schema.enum) && schema.enum.every((item) => typeof item === "string")) {
    const values = schema.enum as string[];
    if (values.length > 0) {
      const [first, ...rest] = values;
      return z.enum([first, ...rest]);
    }
  }

  if ("const" in schema) {
    return z.literal(schema.const as never);
  }

  const typeValue = schema.type;
  if (typeValue === "string") return z.string();
  if (typeValue === "number") return z.number();
  if (typeValue === "integer") return z.number().int();
  if (typeValue === "boolean") return z.boolean();
  if (typeValue === "array") {
    const itemSchema = convertJsonSchema(schema.items);
    return z.array(itemSchema ?? z.unknown());
  }

  if (typeValue === "object") {
    if (!isRecord(schema.properties)) {
      return FALLBACK_EXTRACT_SCHEMA;
    }

    const requiredNames = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((entry): entry is string => typeof entry === "string")
        : [],
    );

    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      const fieldSchema = convertJsonSchema(value) ?? z.unknown();
      shape[key] = requiredNames.has(key) ? fieldSchema : fieldSchema.optional();
    }

    return z.object(shape).passthrough();
  }

  if (isRecord(schema.properties)) {
    return FALLBACK_EXTRACT_SCHEMA;
  }

  return null;
}

function isYesAnswer(answer: string): boolean {
  return parseYesNo(answer) === true;
}

/**
 * Map a free-form yes/no LLM answer to a boolean, or null if undecidable.
 * Tolerant of leading punctuation/quoting, common phrasings, and explicit
 * boolean strings. Used by `coerceForEqual` so authors can write
 * `expect: { kind: "equal", value: true }` against a yes/no question without
 * being defeated by an answer like "Yes, a list is visible." or `"true"`.
 */
function parseYesNo(answer: string): boolean | null {
  const normalized = answer
    .trim()
    .toLowerCase()
    .replace(/^["'`*_\s]+/, "")
    .replace(/["'`*_\s]+$/, "");
  if (normalized.length === 0) return null;
  if (/^(yes|true|y|1|correct|affirmative)\b/.test(normalized)) return true;
  if (/^(no|false|n|0|nope|incorrect|negative|null|none)\b/.test(normalized)) return false;
  return null;
}

/**
 * When the expected value is a boolean and the observed answer is a string,
 * coerce the answer to a boolean using yes/no detection. Otherwise pass the
 * answer through unchanged so strict deep-equality still applies.
 */
function coerceForEqual(answer: unknown, expected: unknown): unknown {
  if (typeof expected !== "boolean") return answer;
  if (typeof answer !== "string") return answer;
  const parsed = parseYesNo(answer);
  return parsed === null ? answer : parsed;
}


const MAX_OBSERVE_TEXT_BYTES = 8_000;

type ObserveContext = { url: string; title: string; text: string };

/**
 * Snapshot the browser state visible to a single observe step. Stagehand's
 * structured-output extract is intentionally bypassed: the LLM operates on
 * plain text and answers via tool calls, which is reliable across local Ollama
 * models that fail on grammar-constrained JSON.
 */
async function captureObserveContext(
  browser: Browser,
  currentUrl: string,
): Promise<ObserveContext> {
  const url = readCurrentUrl(browser, currentUrl);
  // page.title() is a direct DOM read — no LLM, no JSON-schema grammar; safe
  // even when Stagehand's structured extract is failing on the current model.
  const titleResult = await browser.pageTitle();
  const title = titleResult.ok ? titleResult.value : "";
  const textResult = await browser.extractText();
  const text = textResult.ok ? truncateText(textResult.value, MAX_OBSERVE_TEXT_BYTES) : "";
  return { url, title, text };
}

function truncateText(text: string, maxBytes: number): string {
  if (text.length <= maxBytes) return text;
  return `${text.slice(0, maxBytes)}\n…[truncated ${text.length - maxBytes} chars]`;
}

/**
 * Default Observer: a Pi tool-call session that reads pageText/title/url and
 * commits to exactly one of two terminating tools. Bypasses Stagehand's
 * structured-output extract entirely so a flaky JSON-schema vocabulary load
 * never masks a real test outcome.
 */
export async function defaultObserver(
  input: ObserverInput,
): Promise<{ ok: true; answer: string } | { ok: false; error: string }> {
  let answer: string | null = null;

  const answerYesNo = defineTool({
    name: "answer_yes_no",
    label: "Answer yes/no",
    description:
      "Use for yes/no questions. Pass value=\"yes\" if the page satisfies the question, \"no\" if it does not.",
    parameters: Type.Object({
      value: Type.Union([Type.Literal("yes"), Type.Literal("no")]),
    }),
    execute: async (_id, params) => {
      answer = params.value as string;
      return {
        content: [{ type: "text", text: params.value as string }],
        details: {},
        terminate: true,
      };
    },
  });

  const answerText = defineTool({
    name: "answer_text",
    label: "Answer text",
    description:
      "Use when the question asks for a specific string from the page (titles, labels, values). Pass the exact text as `value`.",
    parameters: Type.Object({ value: Type.String() }),
    execute: async (_id, params) => {
      answer = String(params.value);
      return {
        content: [{ type: "text", text: String(params.value) }],
        details: {},
        terminate: true,
      };
    },
  });

  let kea;
  try {
    kea = await createKeaSession({
      role: "tester-observer",
      tools: [answerYesNo, answerText],
      systemPrompt:
        "You answer one question about a single web page using the page's URL, title, and visible text. " +
        "Call exactly one tool: answer_yes_no for yes/no questions, answer_text for text-extraction questions. " +
        "Do not narrate. Do not call both. If the page text is insufficient, prefer answer_yes_no with \"no\".",
      disableRetry: true,
    });
  } catch (err) {
    log.warn(
      {
        scenario: input.scenario.id,
        stepIndex: input.stepIndex,
        sessionId: input.sessionId,
        error: toErrorMessage(err),
      },
      "observer session failed to start",
    );
    return { ok: false, error: `observer session failed: ${toErrorMessage(err)}` };
  }

  const userPrompt = [
    `Question: ${input.question}`,
    `Page URL: ${input.pageUrl || "(unknown)"}`,
    `Page title: ${input.pageTitle || "(unknown)"}`,
    "Visible text:",
    input.pageText || "(empty)",
    "",
    "Call exactly one of answer_yes_no or answer_text.",
  ].join("\n");

  try {
    await kea.session.prompt(userPrompt);
  } catch (err) {
    log.warn(
      {
        scenario: input.scenario.id,
        stepIndex: input.stepIndex,
        sessionId: input.sessionId,
        error: toErrorMessage(err),
      },
      "observer prompt failed",
    );
    return { ok: false, error: `observer prompt failed: ${toErrorMessage(err)}` };
  } finally {
    kea.dispose();
  }

  if (answer === null) {
    return { ok: false, error: "observer did not call any answer tool" };
  }
  return { ok: true, answer };
}

async function defaultSemanticJudge(input: SemanticJudgeInput): Promise<boolean> {
  let verdict: boolean | null = null;

  const chooseYes = defineTool({
    name: "judge_yes",
    label: "Judge yes",
    description: "Use when the answer satisfies the question.",
    parameters: Type.Object({}),
    execute: async (_id, _params, _signal, _onUpdate, _ctx) => {
      verdict = true;
      return {
        content: [{ type: "text", text: "yes" }],
        details: {},
        terminate: true,
      };
    },
  });

  const chooseNo = defineTool({
    name: "judge_no",
    label: "Judge no",
    description: "Use when the answer does not satisfy the question.",
    parameters: Type.Object({}),
    execute: async (_id, _params, _signal, _onUpdate, _ctx) => {
      verdict = false;
      return {
        content: [{ type: "text", text: "no" }],
        details: {},
        terminate: true,
      };
    },
  });

  let kea;
  try {
    kea = await createKeaSession({
      role: "tester-judge",
      tools: [chooseYes, chooseNo],
      systemPrompt:
        "You are a strict semantic assertion judge. Decide whether the provided answer satisfies the question. " +
        "Call exactly one tool: judge_yes when it satisfies, judge_no when it does not. Do not call both.",
      disableRetry: true,
    });
  } catch (err) {
    log.warn(
      {
        scenario: input.scenario.id,
        stepIndex: input.stepIndex,
        sessionId: input.sessionId,
        error: toErrorMessage(err),
      },
      "semantic judge session failed to start",
    );
    return false;
  }

  try {
    await kea.session.prompt(
      `Question: ${input.question}\nAnswer: ${input.answer}\nReply by calling one tool only.`,
    );
  } catch (err) {
    log.warn(
      {
        scenario: input.scenario.id,
        stepIndex: input.stepIndex,
        sessionId: input.sessionId,
        error: toErrorMessage(err),
      },
      "semantic judge prompt failed",
    );
    return false;
  } finally {
    kea.dispose();
  }

  return verdict === true;
}


type ResolvedFlaw = {
  reason: RevisionFeedbackReason;
  diagnosis: string;
  failingStepIndex: number;
  failingStepEvidence: string;
};

/**
 * Run the optional `flawJudge` and reduce its verdict to a `ResolvedFlaw`,
 * or null when the run was a product failure (or classification was disabled,
 * or the judge crashed). The caller uses this to decide between marking the
 * plan and emitting a finding — it never does both.
 */
async function classifyScenarioFlaw(input: {
  runResult: TestRunResult;
  failingStep: StepTraceEntry | null;
  failingEvidence: string | null;
  failingUrl: string | null;
  flawJudge: FlawJudge | undefined;
  scenario: Scenario;
  sessionId: string | null;
}): Promise<ResolvedFlaw | null> {
  if (input.runResult !== "fail" && input.runResult !== "error") return null;
  if (!input.failingStep) return null;
  if (!input.flawJudge) return null;

  let verdict: FlawJudgeVerdict;
  try {
    verdict = await input.flawJudge({
      scenario: input.scenario,
      failingStep: input.failingStep,
      failingEvidence: input.failingEvidence ?? "",
      failingUrl: input.failingUrl,
      pageTitle: null,
      pageDomSnippet: null,
      sessionId: input.sessionId,
    });
  } catch (err) {
    log.warn(
      { scenarioId: input.scenario.id, error: toErrorMessage(err) },
      "flaw judge threw; treating as product failure",
    );
    return null;
  }

  if (verdict.kind !== "scenario_flawed") return null;

  return {
    reason: verdict.reason,
    diagnosis: verdict.diagnosis.trim() || "(no diagnosis)",
    failingStepIndex: input.failingStep.index,
    failingStepEvidence: input.failingStep.evidence,
  };
}

const FLAW_JUDGE_REASONS: readonly RevisionFeedbackReason[] = [
  "ambiguous_target",
  "missing_element",
  "contradictory_steps",
  "impossible_assertion",
  "schema_misuse",
  "other",
] as const;

/**
 * LLM-driven default flaw judge. Wires two terminating tools so the model is
 * forced to commit to exactly one verdict; we read the captured value back
 * after the prompt resolves. Falls back to `product_failure` if the session
 * cannot be created or the prompt errors — a misclassified-as-product-failure
 * is recoverable (the dashboard sees a finding), a misclassified flaw is not.
 */
export async function defaultPlanFlawJudge(input: FlawJudgeInput): Promise<FlawJudgeVerdict> {
  let verdict: FlawJudgeVerdict | null = null;

  const productFailure = defineTool({
    name: "verdict_product_failure",
    label: "Verdict: product failure",
    description:
      "The scenario was reasonable but the system under test misbehaved (button missing, wrong value, server error, broken navigation, …).",
    parameters: Type.Object({}),
    execute: async () => {
      verdict = { kind: "product_failure" };
      return {
        content: [{ type: "text", text: "product_failure" }],
        details: {},
        terminate: true,
      };
    },
  });

  const scenarioFlawed = defineTool({
    name: "verdict_scenario_flawed",
    label: "Verdict: scenario flawed",
    description:
      "The scenario itself is wrong: ambiguous instructions, missing element, contradictory steps, impossible assertion, or misuse of extract/observe shape.",
    parameters: Type.Object({
      reason: Type.Union(
        FLAW_JUDGE_REASONS.map((r) => Type.Literal(r)),
        { description: "Best-fit category from the listed reasons." },
      ),
      diagnosis: Type.String({
        description:
          "One-paragraph natural-language diagnosis the next author run will read as input.",
      }),
    }),
    execute: async (_id, params) => {
      verdict = {
        kind: "scenario_flawed",
        reason: params.reason as RevisionFeedbackReason,
        diagnosis: params.diagnosis,
      };
      return {
        content: [{ type: "text", text: "scenario_flawed" }],
        details: {},
        terminate: true,
      };
    },
  });

  let kea;
  try {
    kea = await createKeaSession({
      role: "tester-flaw-judge",
      tools: [productFailure, scenarioFlawed],
      systemPrompt:
        "You judge whether a failing UI test scenario indicates a real product failure or a flaw in the scenario itself.\n" +
        "You see: scenario name, the failing step (kind, args, evidence), and the page URL.\n" +
        "Pick scenario_flawed when the failure is caused by the scenario's own definition: ambiguous_target (instruction matches multiple things or none), missing_element (assertion or action references something the page does not expose), contradictory_steps (steps cancel each other), impossible_assertion (assertion can never be true on this page), schema_misuse (extract called with wrong schema shape, observe with mismatched expect kind, etc.), or other.\n" +
        "Pick product_failure when the scenario is reasonable and the failure looks like a real defect: server error, broken control, missing user-visible feature, regression in copy/data.\n" +
        "Call exactly one verdict tool. Do not narrate. Do not call both.",
      disableRetry: true,
    });
  } catch (err) {
    log.warn(
      { scenarioId: input.scenario.id, error: toErrorMessage(err) },
      "flaw judge session failed to start; defaulting to product_failure",
    );
    return { kind: "product_failure" };
  }

  const userPrompt = [
    `Scenario: ${input.scenario.name}`,
    `Expected outcome: ${input.scenario.expectedOutcome}`,
    `Failing step #${input.failingStep.index} (${input.failingStep.kind})`,
    `Step args: ${safeJson(input.failingStep.args)}`,
    `Step evidence: ${input.failingEvidence || input.failingStep.evidence}`,
    `Page URL at failure: ${input.failingUrl ?? "(unknown)"}`,
    "",
    "Decide and call exactly one verdict tool.",
  ].join("\n");

  try {
    await kea.session.prompt(userPrompt);
  } catch (err) {
    log.warn(
      { scenarioId: input.scenario.id, error: toErrorMessage(err) },
      "flaw judge prompt failed; defaulting to product_failure",
    );
    return { kind: "product_failure" };
  } finally {
    kea.dispose();
  }

  return verdict ?? { kind: "product_failure" };
}

function readCurrentUrl(browser: Browser, fallback: string): string {
  try {
    const current = browser.currentUrl();
    if (current) return current;
  } catch {
    return fallback;
  }

  return fallback;
}

function resolveSessionId(inputSessionId: string | undefined, store: DataStore): string | null {
  if (inputSessionId && inputSessionId.trim().length > 0) {
    return inputSessionId;
  }

  const fromStore = (store as DataStore & { sessionId?: unknown }).sessionId;
  if (typeof fromStore === "string" && fromStore.trim().length > 0) {
    return fromStore;
  }

  return null;
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
