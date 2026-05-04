import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { createRoutes } from "../app.js";
import { createFeatureRepository } from "./repository.js";
import * as schema from "../db/schema.js";
import type { Scenario } from "@kea/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json();

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("Feature routes (integration)", () => {
  let app: ReturnType<typeof createRoutes>;
  let client: postgres.Sql;
  const now = Date.now();

  beforeAll(async () => {
    client = postgres(TEST_DATABASE_URL!);
    const db = drizzle(client, { schema });
    app = createRoutes(db);
  });

  beforeEach(async () => {
    await client`
      TRUNCATE test_runs, scenarios, test_plans, features, findings, sitemap, messages, sessions
      RESTART IDENTITY CASCADE
    `;
  });

  async function createSession(id: string): Promise<void> {
    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        targetUrl: "https://example.com",
        maxPages: 50,
        startedAt: now,
      }),
    });

    expect(res.status).toBe(201);
  }

  async function createFeatureWithPlan(sessionId: string, name = "Checkout") {
    const res = await app.request(`/api/sessions/${sessionId}/features`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        description: `${name} flow`,
        urlPatterns: ["https://example.com/checkout/*"],
        initialPlan: {
          createdBy: "manual",
          scenarios: [
            {
              name: "can open checkout",
              entryUrl: "https://example.com/checkout",
              steps: [{ kind: "navigate", url: "https://example.com/checkout" }],
              expectedOutcome: "checkout page loads",
            },
          ],
        },
      }),
    });

    expect(res.status).toBe(201);
    return json(res);
  }

  it("POST /api/sessions/:id/features creates a feature with active plan", async () => {
    await createSession("session-create-feature");

    const body = await createFeatureWithPlan("session-create-feature");

    expect(body.feature.name).toBe("Checkout");
    expect(body.activePlan.plan.revision).toBe(1);
    expect(body.activePlan.scenarios).toHaveLength(1);
  });

  it("GET /api/sessions/:id/features lists session features and supports status filter", async () => {
    await createSession("session-list-features");

    await createFeatureWithPlan("session-list-features", "Checkout");

    const staleRes = await app.request("/api/sessions/session-list-features/features", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Search",
        description: "search flow",
        status: "stale",
        urlPatterns: ["https://example.com/search/*"],
      }),
    });
    expect(staleRes.status).toBe(201);

    const allRes = await app.request("/api/sessions/session-list-features/features");
    expect(allRes.status).toBe(200);
    const allBody = await json(allRes);
    expect(allBody).toHaveLength(2);

    const filteredRes = await app.request(
      "/api/sessions/session-list-features/features?status=stale",
    );
    expect(filteredRes.status).toBe(200);
    const filteredBody = await json(filteredRes);
    expect(filteredBody).toHaveLength(1);
    expect(filteredBody[0].feature.name).toBe("Search");
  });

  it("GET /api/sessions/:id/features attaches latestRun to every scenario", async () => {
    // Eager run state lets the dashboard render pass/fail per scenario without
    // a follow-up GET per row — a regression here would re-introduce the
    // "runs hidden behind a second expander" UX issue that made completed
    // sessions look like they hadn't tested anything.
    await createSession("session-latest-run");
    const created = await createFeatureWithPlan("session-latest-run", "Login");
    const scenario = created.activePlan.scenarios[0];

    const beforeRes = await app.request("/api/sessions/session-latest-run/features");
    const beforeBody = await json(beforeRes);
    expect(beforeBody[0].activePlan.scenarios[0].latestRun).toBeNull();

    await app.request(`/api/scenarios/${scenario.id}/runs`, {
      method: "POST",
      headers: { "X-Kea-Session": "session-latest-run", "Content-Type": "application/json" },
      body: JSON.stringify({
        startedAt: now + 10,
        completedAt: now + 20,
        result: "pass",
        stepTrace: [],
      }),
    });

    const afterRes = await app.request("/api/sessions/session-latest-run/features");
    const afterBody = await json(afterRes);
    const latest = afterBody[0].activePlan.scenarios[0].latestRun;
    expect(latest).not.toBeNull();
    expect(latest.result).toBe("pass");
    expect(latest.scenarioId).toBe(scenario.id);
  });

  it("GET /api/sessions/:id/runs returns runs ordered desc with scenario+feature context", async () => {
    await createSession("session-runs-listing");
    const featureA = await createFeatureWithPlan("session-runs-listing", "Auth");
    const featureB = await createFeatureWithPlan("session-runs-listing", "Search");
    const scenarioA = featureA.activePlan.scenarios[0];
    const scenarioB = featureB.activePlan.scenarios[0];

    await app.request(`/api/scenarios/${scenarioA.id}/runs`, {
      method: "POST",
      headers: { "X-Kea-Session": "session-runs-listing", "Content-Type": "application/json" },
      body: JSON.stringify({
        startedAt: now + 100,
        completedAt: now + 200,
        result: "pass",
        stepTrace: [],
      }),
    });
    await app.request(`/api/scenarios/${scenarioB.id}/runs`, {
      method: "POST",
      headers: { "X-Kea-Session": "session-runs-listing", "Content-Type": "application/json" },
      body: JSON.stringify({
        startedAt: now + 300,
        completedAt: now + 400,
        result: "fail",
        stepTrace: [],
      }),
    });

    const res = await app.request("/api/sessions/session-runs-listing/runs");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toHaveLength(2);
    // Newest first.
    expect(body[0].result).toBe("fail");
    expect(body[0].scenarioId).toBe(scenarioB.id);
    expect(body[0].featureName).toBe("Search");
    expect(body[1].result).toBe("pass");
    expect(body[1].featureId).toBe(featureA.feature.id);
  });

  it("GET /api/sessions/:id/runs returns 404 for unknown sessions", async () => {
    const res = await app.request("/api/sessions/missing/runs");
    expect(res.status).toBe(404);
  });

  it("GET /api/features/:id returns detail with all revisions", async () => {
    await createSession("session-feature-detail");
    const created = await createFeatureWithPlan("session-feature-detail");

    const addPlanRes = await app.request(`/api/features/${created.feature.id}/test-plans`, {
      method: "POST",
      headers: { "X-Kea-Session": "session-feature-detail", "Content-Type": "application/json" },
      body: JSON.stringify({
        createdBy: "planner",
        scenarios: [
          {
            name: "checkout with coupon",
            entryUrl: "https://example.com/checkout",
            steps: [{ kind: "navigate", url: "https://example.com/checkout" }],
            expectedOutcome: "coupon accepted",
          },
        ],
      }),
    });

    expect(addPlanRes.status).toBe(201);

    const detailRes = await app.request(`/api/features/${created.feature.id}`, { headers: { "X-Kea-Session": "session-feature-detail" } });
    expect(detailRes.status).toBe(200);

    const detailBody = await json(detailRes);
    expect(detailBody.activePlan.plan.revision).toBe(2);
    expect(detailBody.revisions).toHaveLength(2);
    expect(detailBody.revisions[0].plan.revision).toBe(2);
    expect(detailBody.revisions[1].plan.status).toBe("superseded");
  });

  it("PATCH /api/features/:id updates mutable feature fields", async () => {
    await createSession("session-feature-patch");
    const created = await createFeatureWithPlan("session-feature-patch");

    const patchRes = await app.request(`/api/features/${created.feature.id}`, {
      method: "PATCH",
      headers: { "X-Kea-Session": "session-feature-patch", "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "stale",
        description: "manually marked stale",
        verifiedAt: now,
      }),
    });

    expect(patchRes.status).toBe(200);
    const patchBody = await json(patchRes);
    expect(patchBody.status).toBe("stale");
    expect(patchBody.description).toBe("manually marked stale");
    expect(patchBody.verifiedAt).toBe(now);
  });

  it("POST /api/features/:id/test-plans returns 404 when feature is missing", async () => {
    const res = await app.request("/api/features/99999/test-plans", {
      method: "POST",
      headers: { "X-Kea-Session": "session-missing-resource", "Content-Type": "application/json" },
      body: JSON.stringify({
        createdBy: "manual",
        scenarios: [
          {
            name: "no-op",
            entryUrl: "https://example.com/",
            steps: [{ kind: "navigate", url: "https://example.com/" }],
            expectedOutcome: "no-op",
          },
        ],
      }),
    });

    expect(res.status).toBe(404);
  });

  it("POST /api/scenarios/:id/runs records a run and validates findingId", async () => {
    await createSession("session-test-run");
    const created = await createFeatureWithPlan("session-test-run");
    const scenario = created.activePlan.scenarios[0];

    const findingRes = await app.request("/api/sessions/session-test-run/findings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com/checkout",
        agentId: "tester-1",
        action: "submit checkout",
        result: "500 error",
        severity: "error",
        timestamp: now,
      }),
    });
    expect(findingRes.status).toBe(201);
    const finding = await json(findingRes);

    const runRes = await app.request(`/api/scenarios/${scenario.id}/runs`, {
      method: "POST",
      headers: { "X-Kea-Session": "session-test-run", "Content-Type": "application/json" },
      body: JSON.stringify({
        startedAt: now,
        completedAt: now + 250,
        result: "fail",
        stepTrace: [
          {
            index: 0,
            kind: "navigate",
            args: { url: "https://example.com/checkout" },
            result: "pass",
            evidence: "page loaded",
            latencyMs: 120,
          },
        ],
        findingId: finding.id,
      }),
    });

    expect(runRes.status).toBe(201);
    const run = await json(runRes);
    expect(run.scenarioId).toBe(scenario.id);
    expect(run.findingId).toBe(finding.id);
  });

  it("POST /api/scenarios/:id/runs persists diagnostics and rejects on passing runs", async () => {
    await createSession("session-diag");
    const created = await createFeatureWithPlan("session-diag");
    const scenario = created.activePlan.scenarios[0];

    const diagnostics = {
      failingStepIndex: 1,
      pageUrl: "https://example.com/checkout",
      pageTitle: "Checkout",
      domSnippet: "<html><body>oops</body></html>",
      domTruncated: false,
      consoleMessages: [
        { level: "error" as const, text: "TypeError: x is undefined", timestamp: now },
      ],
      pageErrors: [{ message: "boom", stack: "at foo", timestamp: now }],
      networkFailures: [
        {
          url: "https://api.example.com/checkout",
          method: "POST",
          status: 500,
          statusText: "Internal Server Error",
          errorText: null,
          timestamp: now,
        },
      ],
      expected: "yes",
      observed: "no",
      capturedAt: now + 100,
    };

    const failRes = await app.request(`/api/scenarios/${scenario.id}/runs`, {
      method: "POST",
      headers: { "X-Kea-Session": "session-diag", "Content-Type": "application/json" },
      body: JSON.stringify({
        startedAt: now,
        completedAt: now + 200,
        result: "fail",
        stepTrace: [],
        diagnostics,
      }),
    });
    expect(failRes.status).toBe(201);
    const failRun = await json(failRes);
    expect(failRun.diagnostics).toMatchObject({
      failingStepIndex: 1,
      pageUrl: "https://example.com/checkout",
      expected: "yes",
      observed: "no",
    });

    // Diagnostics on a passing run is a contract violation — reject 422.
    const badRes = await app.request(`/api/scenarios/${scenario.id}/runs`, {
      method: "POST",
      headers: { "X-Kea-Session": "session-diag", "Content-Type": "application/json" },
      body: JSON.stringify({
        startedAt: now,
        completedAt: now + 1,
        result: "pass",
        stepTrace: [],
        diagnostics,
      }),
    });
    expect(badRes.status).toBe(422);
  });

  it("PUT/GET /api/test-runs/:id/artifacts/:kind round-trips screenshot bytes", async () => {
    await createSession("session-artifact");
    const created = await createFeatureWithPlan("session-artifact");
    const scenario = created.activePlan.scenarios[0];

    const runRes = await app.request(`/api/scenarios/${scenario.id}/runs`, {
      method: "POST",
      headers: { "X-Kea-Session": "session-artifact", "Content-Type": "application/json" },
      body: JSON.stringify({
        startedAt: now,
        completedAt: now + 200,
        result: "fail",
        stepTrace: [],
      }),
    });
    const run = await json(runRes);

    // Synthetic 1x1 PNG bytes are sufficient — we're testing transport, not encoding.
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da636060000000000005000167a13d8c0000000049454e44ae426082",
      "hex",
    );

    const upRes = await app.request(`/api/test-runs/${run.id}/artifacts/screenshot`, {
      method: "PUT",
      headers: { "X-Kea-Session": "session-artifact", "Content-Type": "image/png" },
      body: png,
    });
    expect(upRes.status).toBe(204);

    // Re-uploading the same kind must replace, not duplicate.
    const upAgain = await app.request(`/api/test-runs/${run.id}/artifacts/screenshot`, {
      method: "PUT",
      headers: { "X-Kea-Session": "session-artifact", "Content-Type": "image/png" },
      body: png,
    });
    expect(upAgain.status).toBe(204);

    const getRes = await app.request(`/api/test-runs/${run.id}/artifacts/screenshot`, { headers: { "X-Kea-Session": "session-artifact" } });
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("content-type")).toBe("image/png");
    const buf = Buffer.from(await getRes.arrayBuffer());
    expect(buf.equals(png)).toBe(true);

    const listRes = await app.request(`/api/test-runs/${run.id}/artifacts`, { headers: { "X-Kea-Session": "session-artifact" } });
    expect(listRes.status).toBe(200);
    const list = await json(listRes);
    expect(list.kinds).toEqual(["screenshot"]);

    // Unknown kind — 400.
    const badKind = await app.request(`/api/test-runs/${run.id}/artifacts/video`, {
      method: "PUT",
      headers: { "X-Kea-Session": "session-artifact", "Content-Type": "image/png" },
      body: png,
    });
    expect(badKind.status).toBe(400);

    // Unknown run — 404.
    const missing = await app.request("/api/test-runs/999999/artifacts/screenshot", { headers: { "X-Kea-Session": "session-artifact" } });
    expect(missing.status).toBe(404);
  });

  it("GET /api/sessions/:id/scenarios filters by runState", async () => {
    await createSession("session-scenario-list");

    const featureA = await createFeatureWithPlan("session-scenario-list", "Checkout");
    const featureB = await createFeatureWithPlan("session-scenario-list", "Search");

    const checkoutScenario = featureA.activePlan.scenarios[0];
    const searchScenario = featureB.activePlan.scenarios[0];

    await app.request(`/api/scenarios/${checkoutScenario.id}/runs`, {
      method: "POST",
      headers: { "X-Kea-Session": "session-scenario-list", "Content-Type": "application/json" },
      body: JSON.stringify({
        startedAt: now + 100,
        completedAt: now + 200,
        result: "fail",
        stepTrace: [],
      }),
    });

    const failedRes = await app.request(
      "/api/sessions/session-scenario-list/scenarios?runState=failed",
    );
    expect(failedRes.status).toBe(200);
    const failedBody = await json(failedRes);
    expect(failedBody).toHaveLength(1);
    expect(failedBody[0].id).toBe(checkoutScenario.id);

    const unrunRes = await app.request(
      `/api/sessions/session-scenario-list/scenarios?runState=unrun-this-session&since=${now}`,
    );
    expect(unrunRes.status).toBe(200);
    const unrunBody = await json(unrunRes);
    expect(unrunBody.map((row: { id: number }) => row.id)).toContain(searchScenario.id);

    await app.request(`/api/features/${featureB.feature.id}`, {
      method: "PATCH",
      headers: { "X-Kea-Session": "session-scenario-list", "Content-Type": "application/json" },
      body: JSON.stringify({ status: "stale" }),
    });

    const staleRes = await app.request(
      "/api/sessions/session-scenario-list/scenarios?runState=stale",
    );
    expect(staleRes.status).toBe(200);
    const staleBody = await json(staleRes);
    expect(staleBody.map((row: { id: number }) => row.id)).toContain(searchScenario.id);
  });

  it("POST /api/features/:id/test-plans returns 409 on revision race", async () => {
    await createSession("session-race");
    const created = await createFeatureWithPlan("session-race");

    const body = JSON.stringify({
      createdBy: "manual",
      scenarios: [
        {
          name: "race scenario",
          entryUrl: "https://example.com/checkout",
          steps: [{ kind: "navigate", url: "https://example.com/checkout" }],
          expectedOutcome: "still valid",
        },
      ],
    });

    const [first, second] = await Promise.all([
      app.request(`/api/features/${created.feature.id}/test-plans`, {
        method: "POST",
        headers: { "X-Kea-Session": "session-race", "Content-Type": "application/json" },
        body,
      }),
      app.request(`/api/features/${created.feature.id}/test-plans`, {
        method: "POST",
        headers: { "X-Kea-Session": "session-race", "Content-Type": "application/json" },
        body,
      }),
    ]);

    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);
  });

  it("repository addTestPlan transaction rolls back when scenario insert fails", async () => {
    await createSession("session-rollback");
    const created = await createFeatureWithPlan("session-rollback");

    const db = drizzle(client, { schema });
    const repo = createFeatureRepository(db);

    await expect(
      repo.addTestPlan(
        created.feature.id,
        2,
        "manual",
        [
          {
            name: "bad scenario",
            entryUrl: "https://example.com/checkout",
            steps: [{ kind: "navigate", url: "https://example.com/checkout" }],
            expectedOutcome: null,
            createdAt: now,
          } as unknown as Omit<Scenario, "id" | "testPlanId">,
        ],
        now,
      ),
    ).rejects.toBeDefined();

    const active = await repo.getCurrentTestPlan(created.feature.id);
    expect(active?.revision).toBe(1);
    expect(active?.status).toBe("active");

    const detail = await repo.getFeatureWithRevisions(created.feature.id);
    expect(detail?.revisions).toHaveLength(1);
  });

  it("DELETE /api/features/:id cascades plans/scenarios/runs and nulls finding scenarioId", async () => {
    await createSession("session-cascade");
    const created = await createFeatureWithPlan("session-cascade");
    const scenario = created.activePlan.scenarios[0];

    const findingRes = await app.request("/api/sessions/session-cascade/findings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com/checkout",
        agentId: "tester-1",
        action: "assert checkout",
        result: "failed",
        severity: "error",
        timestamp: now,
        scenarioId: scenario.id,
      }),
    });
    expect(findingRes.status).toBe(201);
    const finding = await json(findingRes);

    const runRes = await app.request(`/api/scenarios/${scenario.id}/runs`, {
      method: "POST",
      headers: { "X-Kea-Session": "session-cascade", "Content-Type": "application/json" },
      body: JSON.stringify({
        startedAt: now,
        completedAt: now + 10,
        result: "fail",
        stepTrace: [],
        findingId: finding.id,
      }),
    });
    expect(runRes.status).toBe(201);

    const deleteRes = await app.request(`/api/features/${created.feature.id}`, {
      method: "DELETE",
      headers: { "X-Kea-Session": "session-cascade" },
    });
    expect(deleteRes.status).toBe(204);

    const missingRes = await app.request(`/api/features/${created.feature.id}`, { headers: { "X-Kea-Session": "session-cascade" } });
    expect(missingRes.status).toBe(404);

    const db = drizzle(client, { schema });

    const planRows = await db
      .select()
      .from(schema.testPlans)
      .where(eq(schema.testPlans.featureId, created.feature.id));
    expect(planRows).toHaveLength(0);

    const scenarioRows = await db
      .select()
      .from(schema.scenarios)
      .innerJoin(schema.testPlans, eq(schema.scenarios.testPlanId, schema.testPlans.id))
      .where(eq(schema.testPlans.featureId, created.feature.id));
    expect(scenarioRows).toHaveLength(0);

    const runRows = await db.select().from(schema.testRuns);
    expect(runRows).toHaveLength(0);

    const findingRows = await db
      .select()
      .from(schema.findings)
      .where(
        and(eq(schema.findings.id, finding.id), eq(schema.findings.sessionId, "session-cascade")),
      );
    expect(findingRows).toHaveLength(1);
    expect(findingRows[0].scenarioId).toBeNull();
  });

  it("GET /api/scenarios/:id/runs returns run history newest-first", async () => {
    await createSession("session-runs-list");
    const created = await createFeatureWithPlan("session-runs-list");
    const scenario = created.activePlan.scenarios[0];

    const empty = await app.request(`/api/scenarios/${scenario.id}/runs`, { headers: { "X-Kea-Session": "session-runs-list" } });
    expect(empty.status).toBe(200);
    expect(await json(empty)).toHaveLength(0);

    for (const offset of [100, 200, 300]) {
      const res = await app.request(`/api/scenarios/${scenario.id}/runs`, {
        method: "POST",
        headers: { "X-Kea-Session": "session-runs-list", "Content-Type": "application/json" },
        body: JSON.stringify({
          startedAt: now + offset,
          completedAt: now + offset + 50,
          result: offset === 300 ? "pass" : "fail",
          stepTrace: [],
        }),
      });
      expect(res.status).toBe(201);
    }

    const listRes = await app.request(`/api/scenarios/${scenario.id}/runs`, { headers: { "X-Kea-Session": "session-runs-list" } });
    expect(listRes.status).toBe(200);
    const runs = await json(listRes);
    expect(runs).toHaveLength(3);
    expect(runs[0].startedAt).toBe(now + 300);
    expect(runs[2].startedAt).toBe(now + 100);
    expect(runs[0].result).toBe("pass");
  });

  it("GET /api/scenarios/:id/runs returns 404 for unknown scenario", async () => {
    const res = await app.request("/api/scenarios/999999/runs", { headers: { "X-Kea-Session": "session-missing-resource" } });
    expect(res.status).toBe(404);
  });

  it("GET /api/scenarios/:id/runs returns 400 for non-numeric id", async () => {
    const res = await app.request("/api/scenarios/not-a-number/runs", { headers: { "X-Kea-Session": "session-missing-resource" } });
    expect(res.status).toBe(400);
  });


  it(
    "PATCH /api/test-plans/:id/needs-revision flips active plan and persists feedback",
    async () => {
      await createSession("session-needs-rev");
      const created = await createFeatureWithPlan("session-needs-rev");
      const planId = created.activePlan.plan.id;

      const feedback = {
        rejectedAt: now + 100,
        rejectedByRunId: null,
        reason: "missing_element" as const,
        diagnosis: "the menu trigger does not exist on this page",
        failingStepIndex: 1,
        failingStepEvidence: "act failed: no element matched",
      };

      const res = await app.request(`/api/test-plans/${planId}/needs-revision`, {
        method: "PATCH",
        headers: { "X-Kea-Session": "session-needs-rev", "Content-Type": "application/json" },
        body: JSON.stringify({ feedback }),
      });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.status).toBe("needs_revision");
      expect(body.revisionFeedback).toEqual(feedback);

      // Idempotency / contract: a second PATCH against the now-needs_revision plan
      // is rejected with 409 — we never silently re-mark.
      const second = await app.request(`/api/test-plans/${planId}/needs-revision`, {
        method: "PATCH",
        headers: { "X-Kea-Session": "session-needs-rev", "Content-Type": "application/json" },
        body: JSON.stringify({ feedback }),
      });
      expect(second.status).toBe(409);
    },
  );

  it(
    "POST /api/features/:id/test-plans supersedes a needs_revision plan and bumps revision",
    async () => {
      await createSession("session-revise-flow");
      const created = await createFeatureWithPlan("session-revise-flow");
      const planId = created.activePlan.plan.id;

      // Mark the active plan as needs_revision via the route.
      const mark = await app.request(`/api/test-plans/${planId}/needs-revision`, {
        method: "PATCH",
        headers: { "X-Kea-Session": "session-revise-flow", "Content-Type": "application/json" },
        body: JSON.stringify({
          feedback: {
            rejectedAt: now + 50,
            rejectedByRunId: null,
            reason: "impossible_assertion" as const,
            diagnosis: "page never reaches the asserted state",
            failingStepIndex: 1,
            failingStepEvidence: "observe answered no",
          },
        }),
      });
      expect(mark.status).toBe(200);

      // Author a new revision; the prior needs_revision plan must supersede.
      const revisionRes = await app.request(
        `/api/features/${created.feature.id}/test-plans`,
        {
          method: "POST",
          headers: { "X-Kea-Session": "session-revise-flow", "Content-Type": "application/json" },
          body: JSON.stringify({
            createdBy: "planner",
            scenarios: [
              {
                name: "second attempt",
                entryUrl: "https://example.com/start",
                steps: [{ kind: "navigate", url: "https://example.com/start" }],
                expectedOutcome: "reaches start",
              },
            ],
          }),
        },
      );
      expect(revisionRes.status).toBe(201);
      const revision = await json(revisionRes);
      expect(revision.plan.revision).toBe(2);
      expect(revision.plan.status).toBe("active");

      const repoForTest = createFeatureRepository(drizzle(client, { schema }));
      const detail = await repoForTest.getFeatureWithRevisions(created.feature.id);
      expect(detail?.revisions).toHaveLength(2);
      const prior = detail!.revisions.find((r) => r.plan.id === planId);
      expect(prior?.plan.status).toBe("superseded");
      const current = await repoForTest.getCurrentTestPlan(created.feature.id);
      expect(current?.id).toBe(revision.plan.id);
    },
  );

  it("GET /api/features/:id returns 404 for a missing feature", async () => {
    const res = await app.request("/api/features/123456", { headers: { "X-Kea-Session": "session-missing-resource" } });
    expect(res.status).toBe(404);
  });
});
