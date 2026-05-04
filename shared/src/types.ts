// `URL` is a platform global in Node and modern browsers. Declared here
// because the package's tsconfig deliberately omits the DOM lib.
declare const URL: {
  new (
    input: string,
    base?: string,
  ): { toString(): string; protocol: string; port: string; pathname: string };
};

// -- Page / Sitemap --

export type PageStatus = "discovered" | "visited" | "tested";

export type SitemapEntry = {
  url: string;
  title: string;
  links: string[];
  status: PageStatus;
  discoveredAt: number;
  visitedAt: number | null;
};

export type SitemapStats = {
  total: number;
  discovered: number;
  visited: number;
  tested: number;
};

// -- Findings --

export type Severity = "info" | "warning" | "error" | "critical";

export type Finding = {
  id: number;
  sessionId: string;
  url: string;
  agentId: string;
  action: string;
  result: string;
  severity: Severity;
  timestamp: number;
  /**
   * The scenario whose run produced this finding (FDD-0010 / ADR-024).
   * Null for findings emitted outside the test-runner path (e.g. legacy crawler
   * surfaces, manual ad-hoc submissions). Set NULL on scenario delete so
   * findings outlive plan revisions.
   */
  scenarioId: number | null;
};

export type FindingsStats = Record<Severity, number>;

// -- Sessions --

export type SessionStatus = "running" | "completed" | "failed";

export type Session = {
  id: string;
  targetUrl: string;
  status: SessionStatus;
  maxPages: number;
  config: Record<string, unknown>;
  startedAt: number;
  completedAt: number | null;
};

// -- Chat Messages --

export type ChatMessage = {
  id: number;
  sessionId: string;
  agentId: string;
  content: string;
  thinking: string | null;
  timestamp: number;
};

// -- Helpers --

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (
      (u.protocol === "http:" && u.port === "80") ||
      (u.protocol === "https:" && u.port === "443")
    ) {
      u.port = "";
    }
    if (u.pathname === "") u.pathname = "/";
    return u.toString();
  } catch {
    return raw;
  }
}

// -- Features / Test Plans / Scenarios / Runs (FDD-0010, ADR-024) --

export type FeatureStatus = "active" | "stale" | "retired";
export type FeatureDiscoveredBy = "planner" | "manual" | "crd";

export type Feature = {
  id: number;
  sessionId: string;
  name: string;
  description: string;
  urlPatterns: string[];
  status: FeatureStatus;
  discoveredBy: FeatureDiscoveredBy;
  discoveredAt: number;
  verifiedAt: number | null;
};

export type TestPlanStatus = "active" | "superseded" | "stale" | "needs_revision";
export type TestPlanCreatedBy = "planner" | "manual" | "crd";

/**
 * Why a tester rejected a scenario as flawed. The taxonomy is intentionally
 * coarse — it lets dashboards group like with like and lets the next author
 * run know what shape of mistake to avoid, without pretending to predict every
 * possible flaw. `other` is the escape hatch for verdicts that don't fit.
 */
export type RevisionFeedbackReason =
  | "ambiguous_target"
  | "missing_element"
  | "contradictory_steps"
  | "impossible_assertion"
  | "schema_misuse"
  | "other";

/**
 * The verdict captured when a TestPlan flips to `needs_revision`. Persisted on
 * the rejected plan so the next author revision has concrete diagnosis to work
 * from rather than re-deriving the failure from a step trace.
 */
export type RevisionFeedback = {
  rejectedAt: number;
  /** TestRun id whose failure produced the verdict. Null if rejected outside a run (e.g. manual). */
  rejectedByRunId: number | null;
  reason: RevisionFeedbackReason;
  /** Free-form natural-language diagnosis from the LLM judge. */
  diagnosis: string;
  /** 1-based index of the scenario step that failed (matches `StepTraceEntry.index`). */
  failingStepIndex: number;
  /** Concrete evidence from the failing step (error message, observed value, …). */
  failingStepEvidence: string;
};

export type TestPlan = {
  id: number;
  featureId: number;
  revision: number;
  status: TestPlanStatus;
  verifiedAt: number | null;
  createdBy: TestPlanCreatedBy;
  createdAt: number;
  /** Set only when `status === "needs_revision"`; null otherwise. */
  revisionFeedback: RevisionFeedback | null;
};

export type ExpectClause =
  | { kind: "equal"; value: unknown }
  | { kind: "regex"; pattern: string; flags?: string }
  | { kind: "semantic"; question: string };

export type ScenarioStep =
  | { kind: "navigate"; url: string }
  | { kind: "act"; instruction: string; verifyWith?: string }
  | { kind: "observe"; question: string; expect: ExpectClause }
  | {
      kind: "extract";
      instruction: string;
      schema: Record<string, unknown>;
      bind?: string;
      expect?: ExpectClause;
    };

export type Scenario = {
  id: number;
  testPlanId: number;
  name: string;
  entryUrl: string;
  steps: ScenarioStep[];
  expectedOutcome: string;
  createdAt: number;
};

export type TestRunResult = "pass" | "fail" | "skipped" | "error";

export type StepTraceEntry = {
  index: number;
  kind: "navigate" | "act" | "observe" | "extract";
  args: Record<string, unknown>;
  result: "pass" | "fail" | "skipped" | "error";
  evidence: string;
  latencyMs: number;
};

export type TestRun = {
  id: number;
  scenarioId: number;
  startedAt: number;
  completedAt: number | null;
  result: TestRunResult;
  stepTrace: StepTraceEntry[];
  findingId: number | null;
  /** Populated on fail/error runs; null on pass/skipped and on runs predating diagnostics. */
  diagnostics: RunDiagnostics | null;
};

// -- Run diagnostics (failure-only, captured by tester at the moment of fail/error) --

/**
 * One captured browser console message. Levels mirror Chromium's
 * console event types; anything else collapses to "log".
 */
export type ConsoleMessage = {
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
  timestamp: number;
};

/** Uncaught error from the page (window.onerror / unhandled rejection). */
export type PageError = {
  message: string;
  stack: string | null;
  timestamp: number;
};

/**
 * One failed network request observed during the run. Captured for
 * `requestfailed` (network-layer failure, no response) and for HTTP
 * responses with status >= 400. `errorText` is set only for the former.
 */
export type NetworkFailure = {
  url: string;
  method: string;
  status: number | null;
  statusText: string | null;
  errorText: string | null;
  timestamp: number;
};

/**
 * Failure-time snapshot captured when a TestRun ends in `fail` or `error`.
 * Stored as jsonb on the run; the matching screenshot lives in
 * `test_run_artifacts` keyed by run id. Buffers are bounded so a chatty
 * page can never produce an unbounded diagnostics blob.
 */
/**
 * One LLM-provider call that returned a non-2xx status during the run.
 *
 * Captured by the agent's fetch interceptor (see `Browser.recordLlmFailure`)
 * for requests targeting `LLM_BASE_URL`. Surfaces upstream errors —
 * Ollama's "failed to load model vocabulary", vLLM's quota responses,
 * provider 5xx — that otherwise hide inside the AI SDK's error wrapper.
 *
 * Bodies are truncated at capture time; see `requestBodyTruncated` /
 * `responseBodyTruncated` for the original sizes.
 */
export type LlmFailure = {
  url: string;
  method: string;
  status: number;
  /** JSON or text request body sent to the provider. May be truncated. */
  requestBody: string;
  requestBodyTruncated: boolean;
  /** Provider response body. May be truncated. */
  responseBody: string;
  responseBodyTruncated: boolean;
  /** Round-trip duration in milliseconds. */
  elapsedMs: number;
  timestamp: number;
};

export type RunDiagnostics = {
  /** 1-based index of the step that triggered the failure, or null when no specific step (setup error). */
  failingStepIndex: number | null;
  /** URL of the page at capture time. */
  pageUrl: string;
  /** document.title at capture time. */
  pageTitle: string;
  /** Truncated outerHTML of <html>. UTF-8 length is capped; see `domTruncated`. */
  domSnippet: string;
  domTruncated: boolean;
  consoleMessages: ConsoleMessage[];
  pageErrors: PageError[];
  networkFailures: NetworkFailure[];
  /**
   * LLM-provider calls that returned non-2xx during the run. Empty on healthy
   * runs and on runs that predate the field — treat absence and `[]` as
   * equivalent for rendering purposes.
   */
  llmFailures: LlmFailure[];
  /**
 * For observe/extract steps with an `expect` clause: the expected and
 * observed values that were compared. Both undefined for failures without
 * a structured comparison (navigate, act).
 */
  expected?: unknown;
  observed?: unknown;
  capturedAt: number;
};

export type RerunPolicy = "full" | "stale-only" | { skipIfPassedWithin: string };

export type SessionConfig = {
  maxScenariosPerRun?: number;
  rerunPolicy: RerunPolicy;
  seedFeatures: SeedFeature[];
  [key: string]: unknown;
};

export type SeedFeature = {
  name: string;
  description: string;
  urlPatterns: string[];
  status: FeatureStatus;
  discoveredBy: FeatureDiscoveredBy;
  initialPlan?: {
    createdBy: TestPlanCreatedBy;
    scenarios: Array<{
      name: string;
      entryUrl: string;
      steps: ScenarioStep[];
      expectedOutcome: string;
    }>;
  };
};
