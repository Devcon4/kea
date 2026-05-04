import {
  pgTable,
  text,
  integer,
  bigint,
  serial,
  index,
  jsonb,
  primaryKey,
  varchar,
  uniqueIndex,
  customType,
} from "drizzle-orm/pg-core";

// Postgres `bytea` mapped as Node Buffer. drizzle-orm has no first-class
// bytea helper, so we declare a tiny `customType` here. Inputs/outputs are
// `Buffer`; route handlers convert from base64 / multipart bodies.
const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

// -- Sessions --

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  targetUrl: text("target_url").notNull(),
  status: text("status").notNull().default("running"),
  maxPages: integer("max_pages").notNull().default(50),
  config: jsonb("config").notNull().default({}),
  startedAt: bigint("started_at", { mode: "number" }).notNull(),
  completedAt: bigint("completed_at", { mode: "number" }),
});

// -- Sitemap --

export const sitemap = pgTable(
  "sitemap",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    title: text("title").notNull().default(""),
    links: jsonb("links").notNull().default([]),
    status: text("status").notNull().default("discovered"),
    discoveredAt: bigint("discovered_at", { mode: "number" }).notNull(),
    visitedAt: bigint("visited_at", { mode: "number" }),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.url] }),
    index("idx_sitemap_session_status").on(table.sessionId, table.status),
  ],
);

// -- Findings --

export const findings = pgTable(
  "findings",
  {
    id: serial("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    agentId: text("agent_id").notNull(),
    action: text("action").notNull(),
    result: text("result").notNull(),
    severity: text("severity").notNull().default("info"),
    timestamp: bigint("timestamp", { mode: "number" }).notNull(),
    /** Per ADR-024 / FDD-0010, optional anchor to the scenario the finding came from. */
    scenarioId: integer("scenario_id").references(() => scenarios.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    index("idx_findings_session").on(table.sessionId),
    index("idx_findings_severity").on(table.severity),
    index("idx_findings_scenario").on(table.scenarioId),
  ],
);

// -- Messages (agent chat log) --

export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    agentId: varchar("agent_id", { length: 32 }).notNull(),
    content: text("content").notNull(),
    thinking: text("thinking"),
    timestamp: bigint("timestamp", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_messages_session").on(table.sessionId),
    index("idx_messages_session_ts").on(table.sessionId, table.timestamp),
  ],
);

// -- Features (FDD-0010, ADR-024) --

export const features = pgTable(
  "features",
  {
    id: serial("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    urlPatterns: jsonb("url_patterns").notNull().default([]),
    status: text("status").notNull().default("active"),
    discoveredBy: text("discovered_by").notNull().default("manual"),
    discoveredAt: bigint("discovered_at", { mode: "number" }).notNull(),
    verifiedAt: bigint("verified_at", { mode: "number" }),
  },
  (table) => [
    index("idx_features_session_status").on(table.sessionId, table.status),
    uniqueIndex("uniq_features_session_name").on(table.sessionId, table.name),
  ],
);

// -- Test plans (revision-versioned per Feature) --

export const testPlans = pgTable(
  "test_plans",
  {
    id: serial("id").primaryKey(),
    featureId: integer("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull().default(1),
    /**
     * Plan lifecycle status. `active` is the canonical plan callers should run; 
     * `superseded` is an older revision; `stale` covers feature-status driven invalidation; 
     * `needs_revision` is set by the tester when a scenario flaw (not a product failure) 
     * is detected, and is the signal for `runPlannerAuthor` to cut a new revision with 
     * `revision_feedback` as input. A feature has at most one `active` *or* `needs_revision` 
     * plan at a time; `addTestPlan` supersedes both when introducing a new revision.
     */
    status: text("status").notNull().default("active"),
    verifiedAt: bigint("verified_at", { mode: "number" }),
    createdBy: text("created_by").notNull().default("manual"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    /**
     * Populated only when `status === "needs_revision"`. Captures the tester's
     * verdict at the moment the plan was rejected so the next author run has
     * concrete diagnosis to work from. Shape is `RevisionFeedback` in @kea/shared.
     */
    revisionFeedback: jsonb("revision_feedback"),
  },
  (table) => [
    uniqueIndex("uniq_test_plans_feature_revision").on(table.featureId, table.revision),
    index("idx_test_plans_feature_status").on(table.featureId, table.status),
  ],
);

// -- Scenarios (frozen under a TestPlan revision) --

export const scenarios = pgTable(
  "scenarios",
  {
    id: serial("id").primaryKey(),
    testPlanId: integer("test_plan_id")
      .notNull()
      .references(() => testPlans.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    entryUrl: text("entry_url").notNull(),
    steps: jsonb("steps").notNull().default([]),
    expectedOutcome: text("expected_outcome").notNull().default(""),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [index("idx_scenarios_test_plan").on(table.testPlanId)],
);

// -- Test runs (per scenario; full step trace) --

export const testRuns = pgTable(
  "test_runs",
  {
    id: serial("id").primaryKey(),
    scenarioId: integer("scenario_id")
      .notNull()
      .references(() => scenarios.id, { onDelete: "cascade" }),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    completedAt: bigint("completed_at", { mode: "number" }),
    result: text("result").notNull(),
    stepTrace: jsonb("step_trace").notNull().default([]),
    findingId: integer("finding_id").references(() => findings.id, {
      onDelete: "set null",
    }),
    /**
     * Failure diagnostics captured at the moment of `fail`/`error`. Null for
     * `pass`/`skipped` runs, and for runs that completed before this column
     * existed. Shape is enforced by `RunDiagnosticsSchema` in @kea/shared.
     */
    diagnostics: jsonb("diagnostics"),
  },
  (table) => [index("idx_test_runs_scenario_started").on(table.scenarioId, table.startedAt)],
);

// -- Test run artifacts (binary blobs anchored to a run) --
//
// Stores screenshots and other large binaries that don't belong inline in
// the `diagnostics` jsonb. One row per (run, kind); upserts replace bytes so
// re-uploading the same kind for a run is idempotent. Cascade-delete with
// the run so artifact rows can never outlive their owning run.
export const testRunArtifacts = pgTable(
  "test_run_artifacts",
  {
    id: serial("id").primaryKey(),
    testRunId: integer("test_run_id")
      .notNull()
      .references(() => testRuns.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    contentType: text("content_type").notNull(),
    bytes: bytea("bytes").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("uniq_test_run_artifacts_run_kind").on(table.testRunId, table.kind),
  ],
);
