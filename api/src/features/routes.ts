import { Hono } from "hono";
import {
  CreateFeatureSchema,
  CreateTestPlanSchema,
  CreateTestRunSchema,
  MarkPlanNeedsRevisionSchema,
  TestRunArtifactKindSchema,
  UpdateFeatureSchema,
  normalizeUrl,
} from "@kea/shared";
import type { EventBus } from "../events/bus.js";
import type { FeatureRepository } from "./repository.js";
import {
  addTestPlan,
  addTestRun,
  createFeature,
  selectScenariosToRun,
  updateFeature,
} from "./domain.js";

type SessionLookup = {
  getById(id: string): Promise<unknown | undefined>;
};

type PostgresError = { code?: string };

type ScenarioRunState = "unrun-this-session" | "failed" | "stale";

function parsePositiveInt(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
}

function isPgCode(error: unknown, code: string): error is PostgresError {
  // postgres-js raises errors with `code` at the top level; drizzle wraps them
  // inside `DrizzleQueryError` with the original under `cause`. Check both so
  // route handlers map unique-constraint / FK violations consistently regardless
  // of whether the failing statement was inside a `db.transaction` or not.
  if (typeof error !== "object" || error === null) return false;
  const top = (error as PostgresError).code;
  if (top === code) return true;
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause === "object" && cause !== null && (cause as PostgresError).code === code) {
    return true;
  }
  return false;
}

function parseRunState(input: string | undefined): ScenarioRunState | null {
  if (input === "unrun-this-session") return input;
  if (input === "failed") return input;
  if (input === "stale") return input;
  return null;
}

/**
 * Cross-session resource access guard. Routes keyed by a resource id
 * (`/api/features/:id`, `/api/test-plans/:id/...`, `/api/scenarios/:id/runs`,
 * `/api/test-runs/:id/...`) used to operate on whichever session owned the
 * looked-up row, with no check against the caller's session. A coordinator
 * that hallucinated another session's id could therefore author plans, mark
 * revisions, or record runs against an unrelated session's features.
 *
 * The agent's `ApiClient` always sends `X-Kea-Session: <sessionId>`. The
 * dashboard does not, but it never mutates these resources — it only
 * fetches plain reads via session-scoped routes (or via screenshot `<img>`).
 * So we require the header on the cross-resource paths the agent actually
 * uses for writes plus the read used by the planner-author (`GET
 * /api/features/:id`) so a session cannot fetch and operate on another
 * session's feature data.
 */
type GuardOpts = { resourceLabel: string };

function readSessionHeader(headers: Headers): string | null {
  const value = headers.get("x-kea-session");
  return value && value.length > 0 ? value : null;
}

/**
 * Verify the caller's `X-Kea-Session` matches the resource's owning session.
 * Returns a Response on rejection (caller should `return` it) or null on
 * success. `ownerSessionId` is `undefined` when the looked-up resource does
 * not exist — we surface that as 404 so callers don't need a separate
 * existence check ahead of the guard.
 */
function ownershipGuard(
  c: { req: { raw: Request }; json: (body: unknown, status: number) => Response },
  ownerSessionId: string | undefined,
  opts: GuardOpts,
): Response | null {
  const claimed = readSessionHeader(c.req.raw.headers);
  if (!claimed) {
    return c.json({ error: "X-Kea-Session header required" }, 400);
  }
  if (!ownerSessionId) {
    return c.json({ error: `${opts.resourceLabel} not found` }, 404);
  }
  if (ownerSessionId !== claimed) {
    return c.json({ error: `session does not own this ${opts.resourceLabel}` }, 403);
  }
  return null;
}

export function createFeatureRoutes(
  repo: FeatureRepository,
  sessions: SessionLookup,
  bus: EventBus,
): Hono {
  const app = new Hono();

  /**
   * Emit a `features` refresh for a session, scoped through the bus so the
   * SSE handler delivers it only to subscribers of that session. We always
   * emit AFTER the write commits — a successful emit on a rolled-back write
   * would tell the dashboard to refetch and see no change, training it to
   * distrust the channel.
   */
  function emitFeatures(sessionId: string): void {
    bus.emit({ kind: "features", sessionId, at: Date.now() });
  }

  app.post("/api/sessions/:id/features", async (c) => {
    const body = CreateFeatureSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues }, 400);

    const sessionId = c.req.param("id");
    const session = await sessions.getById(sessionId);
    if (!session) return c.json({ error: "session not found" }, 404);

    const duplicate = await repo.findFeatureByName(sessionId, body.data.name);
    if (duplicate) {
      return c.json({ error: "feature name already exists for session" }, 409);
    }

    const now = Date.now();
    const featureResult = createFeature({
      sessionId,
      name: body.data.name,
      description: body.data.description,
      urlPatterns: body.data.urlPatterns,
      status: body.data.status,
      discoveredBy: body.data.discoveredBy,
      discoveredAt: now,
      verifiedAt: null,
    });

    if (!featureResult.ok) return c.json({ error: featureResult.error }, 422);

    if (body.data.initialPlan) {
      try {
        const created = await repo.createFeatureWithInitialPlan(featureResult.value, {
          revision: 1,
          createdBy: body.data.initialPlan.createdBy,
          scenarios: body.data.initialPlan.scenarios.map((scenario) => ({
            name: scenario.name,
            entryUrl: normalizeUrl(scenario.entryUrl),
            steps: scenario.steps,
            expectedOutcome: scenario.expectedOutcome,
            createdAt: now,
          })),
          now,
        });
        emitFeatures(sessionId);
        return c.json(created, 201);
      } catch (error) {
        if (isPgCode(error, "23505")) {
          return c.json({ error: "feature name already exists for session" }, 409);
        }
        throw error;
      }
    }

    try {
      const feature = await repo.saveFeature(featureResult.value);
      emitFeatures(sessionId);
      return c.json({ feature, activePlan: null }, 201);
    } catch (error) {
      if (isPgCode(error, "23505")) {
        return c.json({ error: "feature name already exists for session" }, 409);
      }
      throw error;
    }
  });

  app.get("/api/sessions/:id/features", async (c) => {
    const sessionId = c.req.param("id");
    const session = await sessions.getById(sessionId);
    if (!session) return c.json({ error: "session not found" }, 404);

    const statusQuery = c.req.query("status");
    let status: "active" | "stale" | "retired" | undefined;
    if (statusQuery !== undefined) {
      if (statusQuery !== "active" && statusQuery !== "stale" && statusQuery !== "retired") {
        return c.json({ error: "invalid feature status" }, 400);
      }
      status = statusQuery;
    }

    const rows = await repo.listFeatures(sessionId, status ? { status } : undefined);
    return c.json(rows);
  });

  app.get("/api/features/:id", async (c) => {
    const id = parsePositiveInt(c.req.param("id"));
    if (id === null) return c.json({ error: "invalid feature id" }, 400);

    const ownerId = await repo.getSessionIdByFeature(id);
    const guard = ownershipGuard(c, ownerId, { resourceLabel: "feature" });
    if (guard) return guard;

    const row = await repo.getFeatureWithRevisions(id);
    if (!row) return c.json({ error: "feature not found" }, 404);

    return c.json(row);
  });

  app.patch("/api/features/:id", async (c) => {
    const id = parsePositiveInt(c.req.param("id"));
    if (id === null) return c.json({ error: "invalid feature id" }, 400);

    const ownerId = await repo.getSessionIdByFeature(id);
    const guard = ownershipGuard(c, ownerId, { resourceLabel: "feature" });
    if (guard) return guard;

    const body = UpdateFeatureSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues }, 400);

    const feature = await repo.getFeature(id);
    if (!feature) return c.json({ error: "feature not found" }, 404);

    const patch = updateFeature(feature, body.data);
    if (!patch.ok) return c.json({ error: patch.error }, 422);

    const updated = await repo.updateFeature(id, patch.value);
    if (!updated) return c.json({ error: "feature not found" }, 404);

    emitFeatures(updated.sessionId);
    return c.json(updated);
  });

  app.delete("/api/features/:id", async (c) => {
    const id = parsePositiveInt(c.req.param("id"));
    if (id === null) return c.json({ error: "invalid feature id" }, 400);

    // Look up sessionId before deletion so we can still emit a refresh after
    // the row is gone; the dashboard's features list refetches and will see
    // the entry vanish.
    const sessionId = await repo.getSessionIdByFeature(id);
    const guard = ownershipGuard(c, sessionId, { resourceLabel: "feature" });
    if (guard) return guard;

    const removed = await repo.deleteFeature(id);
    if (!removed) return c.json({ error: "feature not found" }, 404);

    if (sessionId) emitFeatures(sessionId);
    return c.body(null, 204);
  });

  /**
   * Flip a plan from `active` to `needs_revision`. Used by the tester after an
   * LLM judge classifies a scenario failure as a flaw in the plan rather than
   * a product failure (FDD-0010 / ADR-024). The next coordinator turn will
   * route this feature to author_plan, which reads the persisted feedback.
   */
  app.patch("/api/test-plans/:id/needs-revision", async (c) => {
    const planId = parsePositiveInt(c.req.param("id"));
    if (planId === null) return c.json({ error: "invalid test plan id" }, 400);

    const ownerId = await repo.getSessionIdByPlan(planId);
    const guard = ownershipGuard(c, ownerId, { resourceLabel: "test plan" });
    if (guard) return guard;

    const body = MarkPlanNeedsRevisionSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues }, 400);

    const plan = await repo.getTestPlan(planId);
    if (!plan) return c.json({ error: "test plan not found" }, 404);
    if (plan.status !== "active") {
      return c.json(
        { error: `cannot mark plan as needs_revision from status "${plan.status}"` },
        409,
      );
    }

    const updated = await repo.markPlanNeedsRevision(planId, body.data.feedback);
    if (!updated) {
      // Race: someone else flipped the plan between getTestPlan and the update.
      return c.json({ error: "plan no longer active" }, 409);
    }
    if (ownerId) emitFeatures(ownerId);
    return c.json(updated);
  });

  app.post("/api/features/:id/test-plans", async (c) => {
    const featureId = parsePositiveInt(c.req.param("id"));
    if (featureId === null) return c.json({ error: "invalid feature id" }, 400);

    const ownerId = await repo.getSessionIdByFeature(featureId);
    const guard = ownershipGuard(c, ownerId, { resourceLabel: "feature" });
    if (guard) return guard;

    const body = CreateTestPlanSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues }, 400);

    const feature = await repo.getFeature(featureId);
    if (!feature) return c.json({ error: "feature not found" }, 404);

    const activePlan = await repo.getCurrentTestPlan(feature.id);
    const now = Date.now();
    const planned = addTestPlan(
      feature.id,
      {
        createdBy: body.data.createdBy,
        scenarios: body.data.scenarios,
      },
      activePlan,
      now,
    );
    if (!planned.ok) return c.json({ error: planned.error }, 422);

    try {
      const saved = await repo.addTestPlan(
        feature.id,
        planned.value.plan.revision,
        planned.value.plan.createdBy,
        planned.value.scenarios,
        now,
      );
      emitFeatures(feature.sessionId);
      return c.json(saved, 201);
    } catch (error) {
      if (isPgCode(error, "23505")) {
        return c.json({ error: "test plan revision already exists" }, 409);
      }
      if (isPgCode(error, "23503")) {
        return c.json({ error: "feature not found" }, 404);
      }
      throw error;
    }
  });

  app.post("/api/scenarios/:id/runs", async (c) => {
    const scenarioId = parsePositiveInt(c.req.param("id"));
    if (scenarioId === null) return c.json({ error: "invalid scenario id" }, 400);

    const ownerId = await repo.getSessionIdByScenario(scenarioId);
    const guard = ownershipGuard(c, ownerId, { resourceLabel: "scenario" });
    if (guard) return guard;

    const body = CreateTestRunSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues }, 400);

    const scenario = await repo.getScenario(scenarioId);
    if (!scenario) return c.json({ error: "scenario not found" }, 404);

    if (
      body.data.findingId !== undefined &&
      body.data.findingId !== null &&
      !(await repo.findingExists(body.data.findingId))
    ) {
      return c.json({ error: "finding not found" }, 404);
    }

    const run = addTestRun({
      startedAt: body.data.startedAt,
      completedAt: body.data.completedAt,
      result: body.data.result,
      stepTrace: body.data.stepTrace,
      findingId: body.data.findingId,
      diagnostics: body.data.diagnostics,
    });
    if (!run.ok) return c.json({ error: run.error }, 422);

    const saved = await repo.addTestRun(scenario.id, run.value);
    if (ownerId) emitFeatures(ownerId);
    return c.json(saved, 201);
  });

  app.get("/api/scenarios/:id/runs", async (c) => {
    const scenarioId = parsePositiveInt(c.req.param("id"));
    if (scenarioId === null) return c.json({ error: "invalid scenario id" }, 400);

    const scenario = await repo.getScenario(scenarioId);
    if (!scenario) return c.json({ error: "scenario not found" }, 404);

    const rows = await repo.listRunsForScenario(scenarioId);
    return c.json(rows);
  });

  app.get("/api/sessions/:id/runs", async (c) => {
    const sessionId = c.req.param("id");
    const session = await sessions.getById(sessionId);
    if (!session) return c.json({ error: "session not found" }, 404);

    const rows = await repo.listSessionRuns(sessionId);
    return c.json(rows);
  });

  app.get("/api/sessions/:id/scenarios", async (c) => {
    const sessionId = c.req.param("id");
    const session = await sessions.getById(sessionId);
    if (!session) return c.json({ error: "session not found" }, 404);

    const runState = parseRunState(c.req.query("runState"));
    if (!runState) return c.json({ error: "invalid runState" }, 400);

    const sinceQuery = c.req.query("since");
    const since = sinceQuery ? Number(sinceQuery) : undefined;
    if (runState === "unrun-this-session" && !Number.isFinite(since)) {
      return c.json({ error: "since query param is required" }, 400);
    }

    const candidates = await repo.listScenarios(sessionId, runState, since);
    const result = selectScenariosToRun(candidates, runState, since);
    if (!result.ok) return c.json({ error: result.error }, 422);

    return c.json(result.value);
  });


  /**
   * Upload a binary artifact for a TestRun (currently `screenshot`).
   * Body is `application/octet-stream`; kind is in the URL so callers can't
   * accidentally store a screenshot under a kind the dashboard doesn't render.
   * Cap raw bytes at 5 MiB — large enough for full-viewport PNGs at 2x DPR,
   * small enough that a misbehaving agent can't fill Postgres with one POST.
   */
  app.put("/api/test-runs/:id/artifacts/:kind", async (c) => {
    const runId = parsePositiveInt(c.req.param("id"));
    if (runId === null) return c.json({ error: "invalid test run id" }, 400);

    const ownerId = await repo.getSessionIdByTestRun(runId);
    const guard = ownershipGuard(c, ownerId, { resourceLabel: "test run" });
    if (guard) return guard;

    const kindParse = TestRunArtifactKindSchema.safeParse(c.req.param("kind"));
    if (!kindParse.success) return c.json({ error: "invalid artifact kind" }, 400);
    const kind = kindParse.data;

    const run = await repo.getTestRun(runId);
    if (!run) return c.json({ error: "test run not found" }, 404);

    const contentType = c.req.header("content-type") ?? "application/octet-stream";
    const buf = Buffer.from(await c.req.arrayBuffer());
    const MAX_BYTES = 5 * 1024 * 1024;
    if (buf.byteLength === 0) return c.json({ error: "empty body" }, 400);
    if (buf.byteLength > MAX_BYTES) return c.json({ error: "artifact too large" }, 413);

    await repo.upsertTestRunArtifact({
      testRunId: runId,
      kind,
      contentType,
      bytes: buf,
      createdAt: Date.now(),
    });
    return c.body(null, 204);
  });

  app.get("/api/test-runs/:id/artifacts/:kind", async (c) => {
    const runId = parsePositiveInt(c.req.param("id"));
    if (runId === null) return c.json({ error: "invalid test run id" }, 400);

    const kindParse = TestRunArtifactKindSchema.safeParse(c.req.param("kind"));
    if (!kindParse.success) return c.json({ error: "invalid artifact kind" }, 400);

    const artifact = await repo.getTestRunArtifact(runId, kindParse.data);
    if (!artifact) return c.json({ error: "artifact not found" }, 404);

    return new Response(new Uint8Array(artifact.bytes), { status: 200, headers: { "Content-Type": artifact.contentType } });
  });

  /** Lightweight existence query so the dashboard can skip rendering a 404 image. */
  app.get("/api/test-runs/:id/artifacts", async (c) => {
    const runId = parsePositiveInt(c.req.param("id"));
    if (runId === null) return c.json({ error: "invalid test run id" }, 400);

    const run = await repo.getTestRun(runId);
    if (!run) return c.json({ error: "test run not found" }, 404);

    const kinds = await repo.listTestRunArtifactKinds(runId);
    return c.json({ kinds });
  });
  return app;
}
