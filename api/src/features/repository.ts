import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type {
  Feature,
  FeatureStatus,
  RevisionFeedback,
  Scenario,
  TestPlan,
  TestPlanCreatedBy,
  TestRun,
} from "@kea/shared";
import type { Database } from "../db/connection.js";
import { features, findings, scenarios, testPlans, testRunArtifacts, testRuns } from "../db/schema.js";
import type { ScenarioRunCandidate, ScenarioRunState } from "./domain.js";

export type ScenarioWithLatestRun = Scenario & { latestRun: TestRun | null };

export type FeaturePlanBundle = { plan: TestPlan; scenarios: ScenarioWithLatestRun[] };

export type SessionRunRow = TestRun & {
  scenarioName: string;
  scenarioEntryUrl: string;
  featureId: number;
  featureName: string;
};

export type FeatureWithActivePlan = {
  feature: Feature;
  activePlan: FeaturePlanBundle | null;
};

export type FeatureDetail = FeatureWithActivePlan & {
  revisions: FeaturePlanBundle[];
};

export type FeatureRepository = ReturnType<typeof createFeatureRepository>;

export function createFeatureRepository(db: Database) {
  async function listFeatures(
    sessionId: string,
    opts?: { status?: FeatureStatus },
  ): Promise<FeatureWithActivePlan[]> {
    const featureRows = await db
      .select()
      .from(features)
      .where(
        opts?.status
          ? and(eq(features.sessionId, sessionId), eq(features.status, opts.status))
          : eq(features.sessionId, sessionId),
      )
      .orderBy(desc(features.discoveredAt));

    if (featureRows.length === 0) return [];

    const featureIds = featureRows.map((row) => row.id);
    const activePlans = await db
      .select()
      .from(testPlans)
      .where(and(inArray(testPlans.featureId, featureIds), eq(testPlans.status, "active")));

    const activePlanIds = activePlans.map((row) => row.id);
    const scenarioRows =
      activePlanIds.length > 0
        ? await db
            .select()
            .from(scenarios)
            .where(inArray(scenarios.testPlanId, activePlanIds))
            .orderBy(asc(scenarios.id))
        : [];

    // Resolve the latest run for every scenario in one fan-out so the dashboard
    // can render run state without a follow-up round-trip per scenario.
    const scenariosByPlan = await groupScenariosWithLatestRun(scenarioRows);

    const activeByFeature = new Map<number, TestPlan>();
    for (const row of activePlans) {
      activeByFeature.set(row.featureId, row as TestPlan);
    }

    return featureRows.map((row) => {
      const activePlan = activeByFeature.get(row.id);
      if (!activePlan) {
        return { feature: row as Feature, activePlan: null };
      }

      return {
        feature: row as Feature,
        activePlan: {
          plan: activePlan,
          scenarios: scenariosByPlan.get(activePlan.id) ?? [],
        },
      };
    });
  }

  async function getFeature(id: number): Promise<Feature | undefined> {
    const [row] = await db.select().from(features).where(eq(features.id, id));
    return row as Feature | undefined;
  }

  async function getFeatureWithRevisions(id: number): Promise<FeatureDetail | undefined> {
    const feature = await getFeature(id);
    if (!feature) return undefined;

    const planRows = await db
      .select()
      .from(testPlans)
      .where(eq(testPlans.featureId, id))
      .orderBy(desc(testPlans.revision));

    const planIds = planRows.map((row) => row.id);
    const scenarioRows =
      planIds.length > 0
        ? await db
            .select()
            .from(scenarios)
            .where(inArray(scenarios.testPlanId, planIds))
            .orderBy(asc(scenarios.id))
        : [];

    const scenariosByPlan = await groupScenariosWithLatestRun(scenarioRows);

    const revisions = planRows.map((row) => ({
      plan: row as TestPlan,
      scenarios: scenariosByPlan.get(row.id) ?? [],
    }));

    const activePlan = revisions.find((revision) => revision.plan.status === "active") ?? null;

    return { feature, activePlan, revisions };
  }

  async function findFeatureByName(sessionId: string, name: string): Promise<Feature | undefined> {
    const [row] = await db
      .select()
      .from(features)
      .where(and(eq(features.sessionId, sessionId), eq(features.name, name)));

    return row as Feature | undefined;
  }

  async function saveFeature(input: Omit<Feature, "id">): Promise<Feature> {
    const [row] = await db.insert(features).values(input).returning();
    return row as Feature;
  }

  async function createFeatureWithInitialPlan(
    featureInput: Omit<Feature, "id">,
    initialPlan: {
      revision: number;
      createdBy: TestPlanCreatedBy;
      scenarios: Array<Omit<Scenario, "id" | "testPlanId">>;
      now: number;
    },
  ): Promise<FeatureWithActivePlan> {
    return db.transaction(async (tx) => {
      const [featureRow] = await tx.insert(features).values(featureInput).returning();

      const [planRow] = await tx
        .insert(testPlans)
        .values({
          featureId: featureRow.id,
          revision: initialPlan.revision,
          status: "active",
          verifiedAt: null,
          createdBy: initialPlan.createdBy,
          createdAt: initialPlan.now,
        })
        .returning();

      const scenarioRows = await tx
        .insert(scenarios)
        .values(
          initialPlan.scenarios.map((scenario) => ({
            testPlanId: planRow.id,
            name: scenario.name,
            entryUrl: scenario.entryUrl,
            steps: scenario.steps,
            expectedOutcome: scenario.expectedOutcome,
            createdAt: scenario.createdAt,
          })),
        )
        .returning();

      return {
        feature: featureRow as Feature,
        activePlan: {
          plan: planRow as TestPlan,
          scenarios: (scenarioRows as Scenario[]).map((row) => ({ ...row, latestRun: null })),
        },
      };
    });
  }

  async function updateFeature(
    id: number,
    patch: Partial<Omit<Feature, "id" | "sessionId" | "discoveredBy" | "discoveredAt">>,
  ): Promise<Feature | undefined> {
    if (Object.keys(patch).length === 0) {
      return getFeature(id);
    }

    const [row] = await db.update(features).set(patch).where(eq(features.id, id)).returning();

    return row as Feature | undefined;
  }

  async function deleteFeature(id: number): Promise<boolean> {
    const rows = await db
      .delete(features)
      .where(eq(features.id, id))
      .returning({ id: features.id });

    return rows.length > 0;
  }

  /**
   * The plan that currently "owns" this feature — either `active` (runnable)
   * or `needs_revision` (rejected, awaiting re-author). Returns at most one row;
   * the supersede step in `addTestPlan` enforces the invariant that a feature
   * has at most one such plan at any time.
   */
  async function getCurrentTestPlan(featureId: number): Promise<TestPlan | undefined> {
    const [row] = await db
      .select()
      .from(testPlans)
      .where(
        and(
          eq(testPlans.featureId, featureId),
          inArray(testPlans.status, ["active", "needs_revision"]),
        ),
      )
      .orderBy(desc(testPlans.revision));

    return row as TestPlan | undefined;
  }

  async function addTestPlan(
    featureId: number,
    revision: number,
    createdBy: TestPlanCreatedBy,
    scenariosInput: Array<Omit<Scenario, "id" | "testPlanId">>,
    now: number,
  ): Promise<FeaturePlanBundle> {
    return db.transaction(async (tx) => {
      await tx
        .update(testPlans)
        .set({ status: "superseded" })
        .where(
          and(
            eq(testPlans.featureId, featureId),
            inArray(testPlans.status, ["active", "needs_revision"]),
          ),
        );

      const [planRow] = await tx
        .insert(testPlans)
        .values({
          featureId,
          revision,
          status: "active",
          verifiedAt: null,
          createdBy,
          createdAt: now,
        })
        .returning();

      const scenarioRows = await tx
        .insert(scenarios)
        .values(
          scenariosInput.map((scenario) => ({
            testPlanId: planRow.id,
            name: scenario.name,
            entryUrl: scenario.entryUrl,
            steps: scenario.steps,
            expectedOutcome: scenario.expectedOutcome,
            createdAt: scenario.createdAt,
          })),
        )
        .returning();

      return {
        plan: planRow as TestPlan,
        scenarios: (scenarioRows as Scenario[]).map((row) => ({ ...row, latestRun: null })),
      };
    });
  }

  /**
   * Resolve sessionId for an entity living under a feature. Used by the SSE
   * event-emit code paths in routes that only see featureId / scenarioId /
   * planId; emits without sessionId would force every dashboard to refetch
   * every feature pane on every mutation.
   */
  async function getSessionIdByFeature(featureId: number): Promise<string | undefined> {
    const [row] = await db
      .select({ sessionId: features.sessionId })
      .from(features)
      .where(eq(features.id, featureId));
    return row?.sessionId;
  }

  async function getSessionIdByPlan(planId: number): Promise<string | undefined> {
    const [row] = await db
      .select({ sessionId: features.sessionId })
      .from(testPlans)
      .innerJoin(features, eq(features.id, testPlans.featureId))
      .where(eq(testPlans.id, planId));
    return row?.sessionId;
  }

  async function getSessionIdByScenario(scenarioId: number): Promise<string | undefined> {
    const [row] = await db
      .select({ sessionId: features.sessionId })
      .from(scenarios)
      .innerJoin(testPlans, eq(testPlans.id, scenarios.testPlanId))
      .innerJoin(features, eq(features.id, testPlans.featureId))
      .where(eq(scenarios.id, scenarioId));
    return row?.sessionId;
  }

  async function getTestPlan(id: number): Promise<TestPlan | undefined> {
    const [row] = await db.select().from(testPlans).where(eq(testPlans.id, id));
    return row as TestPlan | undefined;
  }

  /**
   * Flip a plan from `active` to `needs_revision` and persist the tester's
   * verdict. Returns the updated row, or undefined when the plan is not in
   * `active` (idempotent: a plan already `needs_revision` or `superseded` is
   * not transitioned again — the route surfaces this as a 409).
   */
  async function markPlanNeedsRevision(
    planId: number,
    feedback: RevisionFeedback,
  ): Promise<TestPlan | undefined> {
    const [row] = await db
      .update(testPlans)
      .set({ status: "needs_revision", revisionFeedback: feedback })
      .where(and(eq(testPlans.id, planId), eq(testPlans.status, "active")))
      .returning();
    return row as TestPlan | undefined;
  }

  async function getScenario(id: number): Promise<Scenario | undefined> {
    const [row] = await db.select().from(scenarios).where(eq(scenarios.id, id));

    return row as Scenario | undefined;
  }

  async function addTestRun(
    scenarioId: number,
    run: Omit<TestRun, "id" | "scenarioId">,
  ): Promise<TestRun> {
    const [row] = await db
      .insert(testRuns)
      .values({
        scenarioId,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        result: run.result,
        stepTrace: run.stepTrace,
        findingId: run.findingId,
        diagnostics: run.diagnostics,
      })
      .returning();

    return row as TestRun;
  }

  async function listScenarios(
    sessionId: string,
    _runState: ScenarioRunState,
    _since?: number,
  ): Promise<ScenarioRunCandidate[]> {
    const rows = await db
      .select({ scenario: scenarios, featureStatus: features.status })
      .from(scenarios)
      .innerJoin(testPlans, eq(testPlans.id, scenarios.testPlanId))
      .innerJoin(features, eq(features.id, testPlans.featureId))
      .where(and(eq(features.sessionId, sessionId), eq(testPlans.status, "active")))
      .orderBy(asc(scenarios.id));

    const latestRuns = await Promise.all(rows.map((row) => latestRunForScenario(row.scenario.id)));

    return rows.map((row, index) => ({
      scenario: row.scenario as Scenario,
      featureStatus: row.featureStatus as FeatureStatus,
      latestRun: latestRuns[index],
    }));
  }

  async function listRunsForScenario(scenarioId: number): Promise<TestRun[]> {
    const rows = await db
      .select()
      .from(testRuns)
      .where(eq(testRuns.scenarioId, scenarioId))
      .orderBy(desc(testRuns.startedAt));

    return rows as TestRun[];
  }

  async function latestRunForScenario(scenarioId: number): Promise<TestRun | null> {
    const [row] = await db
      .select()
      .from(testRuns)
      .where(eq(testRuns.scenarioId, scenarioId))
      .orderBy(desc(testRuns.startedAt))
      .limit(1);

    return row ? (row as TestRun) : null;
  }

  /**
   * Group scenario rows by plan and attach the latest TestRun (or null) to
   * each. Done in a single fan-out so the dashboard renders run state without
   * a follow-up round-trip per scenario — a session with 50 scenarios was
   * costing 50 sequential GETs after `listFeatures`.
   */
  async function groupScenariosWithLatestRun(
    scenarioRows: ReadonlyArray<{ id: number; testPlanId: number } & Record<string, unknown>>,
  ): Promise<Map<number, ScenarioWithLatestRun[]>> {
    if (scenarioRows.length === 0) return new Map();

    const latestRuns = await Promise.all(scenarioRows.map((row) => latestRunForScenario(row.id)));

    const byPlan = new Map<number, ScenarioWithLatestRun[]>();
    for (let i = 0; i < scenarioRows.length; i += 1) {
      const row = scenarioRows[i] as Scenario;
      const enriched: ScenarioWithLatestRun = { ...row, latestRun: latestRuns[i] };
      const bucket = byPlan.get(row.testPlanId) ?? [];
      bucket.push(enriched);
      byPlan.set(row.testPlanId, bucket);
    }
    return byPlan;
  }

  /**
   * Every TestRun in the session, newest first, joined with enough scenario
   * + feature context for the dashboard's Runs tab to render without a
   * second lookup pass. Drives the fan-out that used to require the operator
   * to expand one scenario at a time to discover what had run.
   */
  async function listSessionRuns(sessionId: string): Promise<SessionRunRow[]> {
    const rows = await db
      .select({
        run: testRuns,
        scenarioName: scenarios.name,
        scenarioEntryUrl: scenarios.entryUrl,
        featureId: features.id,
        featureName: features.name,
      })
      .from(testRuns)
      .innerJoin(scenarios, eq(scenarios.id, testRuns.scenarioId))
      .innerJoin(testPlans, eq(testPlans.id, scenarios.testPlanId))
      .innerJoin(features, eq(features.id, testPlans.featureId))
      .where(eq(features.sessionId, sessionId))
      .orderBy(desc(testRuns.startedAt));

    return rows.map((row) => ({
      ...(row.run as TestRun),
      scenarioName: row.scenarioName,
      scenarioEntryUrl: row.scenarioEntryUrl,
      featureId: row.featureId,
      featureName: row.featureName,
    }));
  }

  async function findingExists(findingId: number): Promise<boolean> {
    const [row] = await db
      .select({ id: findings.id })
      .from(findings)
      .where(eq(findings.id, findingId))
      .limit(1);

    return Boolean(row);
  }

  /**
   * Insert-or-replace a binary artifact for a run. The unique index on
   * (test_run_id, kind) makes upload idempotent — re-uploading a screenshot
   * for the same run replaces the previous bytes rather than accumulating
   * duplicates we'd then have to disambiguate at fetch time.
   */
  async function upsertTestRunArtifact(input: {
    testRunId: number;
    kind: string;
    contentType: string;
    bytes: Buffer;
    createdAt: number;
  }): Promise<void> {
    await db
      .insert(testRunArtifacts)
      .values(input)
      .onConflictDoUpdate({
        target: [testRunArtifacts.testRunId, testRunArtifacts.kind],
        set: {
          contentType: input.contentType,
          bytes: input.bytes,
          createdAt: input.createdAt,
        },
      });
  }

  async function getTestRunArtifact(
    testRunId: number,
    kind: string,
  ): Promise<{ contentType: string; bytes: Buffer } | undefined> {
    const [row] = await db
      .select({ contentType: testRunArtifacts.contentType, bytes: testRunArtifacts.bytes })
      .from(testRunArtifacts)
      .where(and(eq(testRunArtifacts.testRunId, testRunId), eq(testRunArtifacts.kind, kind)));
    return row;
  }

  async function listTestRunArtifactKinds(testRunId: number): Promise<string[]> {
    const rows = await db
      .select({ kind: testRunArtifacts.kind })
      .from(testRunArtifacts)
      .where(eq(testRunArtifacts.testRunId, testRunId));
    return rows.map((r) => r.kind);
  }

  async function getTestRun(id: number): Promise<TestRun | undefined> {
    const [row] = await db.select().from(testRuns).where(eq(testRuns.id, id));
    return row as TestRun | undefined;
  }

  async function getSessionIdByTestRun(runId: number): Promise<string | undefined> {
    const [row] = await db
      .select({ sessionId: features.sessionId })
      .from(testRuns)
      .innerJoin(scenarios, eq(scenarios.id, testRuns.scenarioId))
      .innerJoin(testPlans, eq(testPlans.id, scenarios.testPlanId))
      .innerJoin(features, eq(features.id, testPlans.featureId))
      .where(eq(testRuns.id, runId));
    return row?.sessionId;
  }

  return {
    listFeatures,
    getFeature,
    getFeatureWithRevisions,
    findFeatureByName,
    saveFeature,
    createFeatureWithInitialPlan,
    updateFeature,
    deleteFeature,
    getCurrentTestPlan,
    getTestPlan,
    markPlanNeedsRevision,
    getSessionIdByFeature,
    getSessionIdByPlan,
    getSessionIdByScenario,
    getSessionIdByTestRun,
    addTestPlan,
    getScenario,
    addTestRun,
    listScenarios,
    listRunsForScenario,
    latestRunForScenario,
    listSessionRuns,
    findingExists,
    upsertTestRunArtifact,
    getTestRunArtifact,
    listTestRunArtifactKinds,
    getTestRun,
  };
}
