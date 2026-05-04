import { z } from "zod";

// `URLPattern` is a platform global in Node ≥18.16. Declared here so the
// schema layer can validate operator/agent-supplied patterns without pulling
// in the full DOM lib.
declare const URLPattern: { new (input: string): unknown };

// -- Page / Sitemap --

export const PageStatusSchema = z.enum(["discovered", "visited", "tested"]);

export const UpsertPageSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  links: z.array(z.string()),
  status: PageStatusSchema,
  discoveredAt: z.number().optional(),
  visitedAt: z.number().nullable().optional(),
});

export const VisitPageSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  links: z.array(z.string()),
});

export const DiscoverPageSchema = z.object({
  url: z.string().url(),
});

// -- Findings --

export const SeveritySchema = z.enum(["info", "warning", "error", "critical"]);

export const CreateFindingSchema = z.object({
  url: z.string().url(),
  agentId: z.string().min(1),
  action: z.string().min(1),
  result: z.string().min(1),
  severity: SeveritySchema,
  timestamp: z.number(),
  /**
   * Optional anchor to the scenario this finding originated from.
   * Older findings predate the feature-driven model and remain valid without it.
   * Per ADR-024, severity is derived from scenario outcome when this is set.
   */
  scenarioId: z.number().int().positive().optional(),
});

// -- Chat Messages --

export const CreateChatMessageSchema = z.object({
  agentId: z.string().min(1),
  content: z.string().min(1),
  thinking: z.string().nullable().optional(),
  timestamp: z.number(),
});

// -- Features (per ADR-024) --

export const FeatureStatusSchema = z.enum(["active", "stale", "retired"]);
export const FeatureDiscoveredBySchema = z.enum(["planner", "manual", "crd"]);

/**
 * URLPattern source string. Validated at parse time using the platform-native
 * `URLPattern` constructor (Node ≥18.16). A string that doesn't parse is rejected
 * — agents and operators never silently accept a bad pattern.
 */
export const UrlPatternSchema = z
  .string()
  .min(1)
  .refine(
    (s) => {
      try {
        // Constructor throws on invalid pattern syntax.
        // eslint-disable-next-line no-new
        new URLPattern(s);
        return true;
      } catch {
        return false;
      }
    },
    { message: "invalid URLPattern" },
  );

// -- Test plans, scenarios, runs --

export const TestPlanStatusSchema = z.enum([
  "active",
  "superseded",
  "stale",
  "needs_revision",
]);
export const TestPlanCreatedBySchema = z.enum(["planner", "manual", "crd"]);

/**
 * Verdict reasons for `needs_revision` test plans. Coarse on purpose — the
 * dashboards group by reason, the next author run uses it as a hint, and `other`
 * is always available when the judge's verdict doesn't fit.
 */
export const RevisionFeedbackReasonSchema = z.enum([
  "ambiguous_target",
  "missing_element",
  "contradictory_steps",
  "impossible_assertion",
  "schema_misuse",
  "other",
]);

export const RevisionFeedbackSchema = z.object({
  rejectedAt: z.number(),
  rejectedByRunId: z.number().int().positive().nullable(),
  reason: RevisionFeedbackReasonSchema,
  diagnosis: z.string().min(1),
  failingStepIndex: z.number().int().positive(),
  failingStepEvidence: z.string(),
});

export const MarkPlanNeedsRevisionSchema = z.object({
  feedback: RevisionFeedbackSchema,
});

/**
 * A scenario step. Discriminated by `kind`. Per FDD-0010, the four kinds cover:
 *  - `navigate`: drive the browser to a URL.
 *  - `act`: LLM-guided UI action; an optional `verifyWith` triggers a follow-up
 *    observe to confirm the post-condition (Stagehand's act is optimistic).
 *  - `observe`: yes/no question with a structured assertion.
 *  - `extract`: structured extraction; optional `bind` makes the value
 *    available to subsequent steps via `${name}` substitution.
 *
 * String values may contain `${name}` placeholders that the tester substitutes
 * from previously-bound extract results before dispatching the step.
 */
export const ExpectClauseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("equal"), value: z.unknown() }),
  z.object({ kind: z.literal("regex"), pattern: z.string().min(1), flags: z.string().optional() }),
  z.object({ kind: z.literal("semantic"), question: z.string().min(1) }),
]);

export const ScenarioStepSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), url: z.string().min(1) }),
  z.object({
    kind: z.literal("act"),
    instruction: z.string().min(1),
    /** Post-condition observe; recommended whenever the act is state-changing. */
    verifyWith: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("observe"),
    question: z.string().min(1),
    expect: ExpectClauseSchema,
  }),
  z.object({
    kind: z.literal("extract"),
    /**
     * Natural-language instruction passed to the browser specialist alongside
     * the schema. Stagehand requires both — the schema describes the shape,
     * the instruction tells it what to look for. Required, non-empty.
     */
    instruction: z.string().min(1),
    /**
     * JSON-schema-shaped object describing the structure to extract.
     * Stored as opaque JSON; the tester forwards it to the browser specialist.
     */
    schema: z.record(z.string(), z.unknown()),
    /** Bind the extracted value as `${bind}` for later steps. */
    bind: z
      .string()
      .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
      .optional(),
    expect: ExpectClauseSchema.optional(),
  }),
]);

const SCENARIO_MAX_STEPS = 8;

export const ScenarioSchema = z.object({
  id: z.number().int().positive(),
  testPlanId: z.number().int().positive(),
  name: z.string().min(1),
  entryUrl: z.string().url(),
  steps: z.array(ScenarioStepSchema).min(1).max(SCENARIO_MAX_STEPS),
  expectedOutcome: z.string().min(1),
  createdAt: z.number(),
});

export const CreateScenarioSchema = z.object({
  name: z.string().min(1),
  entryUrl: z.string().url(),
  steps: z.array(ScenarioStepSchema).min(1).max(SCENARIO_MAX_STEPS),
  expectedOutcome: z.string().min(1),
});

export const TestPlanSchema = z.object({
  id: z.number().int().positive(),
  featureId: z.number().int().positive(),
  revision: z.number().int().positive(),
  status: TestPlanStatusSchema,
  verifiedAt: z.number().nullable(),
  createdBy: TestPlanCreatedBySchema,
  createdAt: z.number(),
  revisionFeedback: RevisionFeedbackSchema.nullable(),
});

export const CreateTestPlanSchema = z.object({
  createdBy: TestPlanCreatedBySchema.default("manual"),
  scenarios: z.array(CreateScenarioSchema).min(1).max(20),
});

export const FeatureSchema = z.object({
  id: z.number().int().positive(),
  sessionId: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  urlPatterns: z.array(UrlPatternSchema).min(1),
  status: FeatureStatusSchema,
  discoveredBy: FeatureDiscoveredBySchema,
  discoveredAt: z.number(),
  verifiedAt: z.number().nullable(),
});

export const CreateFeatureSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  urlPatterns: z.array(UrlPatternSchema).min(1),
  status: FeatureStatusSchema.default("active"),
  discoveredBy: FeatureDiscoveredBySchema.default("manual"),
  /** Optional initial test plan to author atomically with the feature. */
  initialPlan: CreateTestPlanSchema.optional(),
});

export const UpdateFeatureSchema = z.object({
  status: FeatureStatusSchema.optional(),
  description: z.string().optional(),
  urlPatterns: z.array(UrlPatternSchema).min(1).optional(),
  /** Set to `Date.now()` to mark the feature freshly verified. */
  verifiedAt: z.number().nullable().optional(),
});

export const TestRunResultSchema = z.enum(["pass", "fail", "skipped", "error"]);

export const StepTraceEntrySchema = z.object({
  index: z.number().int().nonnegative(),
  kind: z.enum(["navigate", "act", "observe", "extract"]),
  /** Step args after `${binding}` substitution, for reproducibility. */
  args: z.record(z.string(), z.unknown()),
  result: z.enum(["pass", "fail", "skipped", "error"]),
  /** Free-form evidence: extracted value, observe answer, error message. */
  evidence: z.string(),
  latencyMs: z.number().nonnegative(),
});

// -- Run diagnostics (failure-time snapshot) --
//
// Bounds applied at capture time live in the agent (see Browser ring
// buffers). The schema enforces structural shape and string types so the
// API can validate uploads from any caller, not just our agent.
export const ConsoleMessageSchema = z.object({
  level: z.enum(["log", "info", "warn", "error", "debug"]),
  text: z.string(),
  timestamp: z.number(),
});

export const PageErrorSchema = z.object({
  message: z.string(),
  stack: z.string().nullable(),
  timestamp: z.number(),
});

export const NetworkFailureSchema = z.object({
  url: z.string(),
  method: z.string(),
  status: z.number().int().nullable(),
  statusText: z.string().nullable(),
  errorText: z.string().nullable(),
  timestamp: z.number(),
});

export const LlmFailureSchema = z.object({
  url: z.string(),
  method: z.string(),
  status: z.number().int(),
  requestBody: z.string(),
  requestBodyTruncated: z.boolean(),
  responseBody: z.string(),
  responseBodyTruncated: z.boolean(),
  elapsedMs: z.number().nonnegative(),
  timestamp: z.number(),
});

export const RunDiagnosticsSchema = z.object({
  failingStepIndex: z.number().int().positive().nullable(),
  pageUrl: z.string(),
  pageTitle: z.string(),
  domSnippet: z.string(),
  domTruncated: z.boolean(),
  consoleMessages: z.array(ConsoleMessageSchema),
  pageErrors: z.array(PageErrorSchema),
  networkFailures: z.array(NetworkFailureSchema),
  // Default to [] so rows persisted before this field was added validate
  // (jsonb on the run preserves whatever the agent uploaded; older rows have
  // no `llmFailures` key). New uploads MUST include it via the agent path.
  llmFailures: z.array(LlmFailureSchema).default([]),
  expected: z.unknown().optional(),
  observed: z.unknown().optional(),
  capturedAt: z.number(),
});

export const TestRunArtifactKindSchema = z.enum(["screenshot"]);

export const TestRunSchema = z.object({
  id: z.number().int().positive(),
  scenarioId: z.number().int().positive(),
  startedAt: z.number(),
  completedAt: z.number().nullable(),
  result: TestRunResultSchema,
  stepTrace: z.array(StepTraceEntrySchema),
  findingId: z.number().int().positive().nullable(),
  diagnostics: RunDiagnosticsSchema.nullable(),
});

export const CreateTestRunSchema = z.object({
  startedAt: z.number(),
  completedAt: z.number(),
  result: TestRunResultSchema,
  stepTrace: z.array(StepTraceEntrySchema),
  findingId: z.number().int().positive().nullable().optional(),
  diagnostics: RunDiagnosticsSchema.nullable().optional(),
});

// -- Sessions --

export const SessionStatusSchema = z.enum(["running", "completed", "failed"]);

/**
 * Rerun policy controls which scenarios the coordinator executes each session.
 * Default `"full"` — every active scenario runs every session, giving the
 * Operator fresh evidence on every crawl. `"stale-only"` skips scenarios whose
 * feature is still `active` and recently verified. The object form skips a
 * scenario whose last successful run was within the given duration.
 */
export const RerunPolicySchema = z.union([
  z.literal("full"),
  z.literal("stale-only"),
  z.object({
    skipIfPassedWithin: z.string().regex(/^\d+(ms|s|m|h|d)$/, {
      message: "duration like '500ms' / '30s' / '15m' / '1h' / '7d'",
    }),
  }),
]);

export const SessionConfigSchema = z
  .object({
    maxScenariosPerRun: z.number().int().positive().optional(),
    rerunPolicy: RerunPolicySchema.default("full"),
    seedFeatures: z.array(CreateFeatureSchema).default([]),
  })
  .passthrough();

export const CreateSessionSchema = z.object({
  id: z.string().min(1),
  targetUrl: z.string().url(),
  status: SessionStatusSchema.default("running"),
  maxPages: z.number().int().positive(),
  config: SessionConfigSchema.default({
    rerunPolicy: "full",
    seedFeatures: [],
  }),
  startedAt: z.number(),
  completedAt: z.number().nullable().optional(),
});

export const UpdateSessionSchema = z.object({
  status: SessionStatusSchema.optional(),
  completedAt: z.number().nullable().optional(),
});
