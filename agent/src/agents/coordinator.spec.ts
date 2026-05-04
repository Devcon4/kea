import { describe, expect, it } from "vitest";
import {
  COORDINATOR_SYSTEM_PROMPT,
  buildCoordinatorTools,
  buildFallbackPlan,
} from "./coordinator.js";
import type { CoordinatorDeps } from "./coordinator.js";
import type { Browser } from "../browser/stagehand.js";
import type {
  Feature,
  FeatureWithActivePlan,
  Scenario,
  SitemapEntry,
  SitemapStats,
} from "../memory/data-store.js";
import { FakeDataStore } from "../pi/test-harness.js";

function entry(url: string, status: SitemapEntry["status"]): SitemapEntry {
  return {
    url,
    title: "",
    links: [],
    status,
    discoveredAt: 1,
    visitedAt: status === "discovered" ? null : 100,
  };
}

function feature(
  id: number,
  status: Feature["status"],
  activePlan: FeatureWithActivePlan["activePlan"] = null,
): FeatureWithActivePlan {
  return {
    feature: {
      id,
      sessionId: "session-1",
      name: `feature-${id}`,
      description: "",
      urlPatterns: [`https://example.com/feature-${id}/*`],
      status,
      discoveredBy: "manual",
      discoveredAt: 1,
      verifiedAt: null,
    },
    activePlan,
  };
}

function scenario(id: number): Scenario {
  return {
    id,
    testPlanId: 1,
    name: `scenario-${id}`,
    entryUrl: "https://example.com/start",
    steps: [{ kind: "navigate", url: "https://example.com/start" }],
    expectedOutcome: "works",
    createdAt: 1,
  };
}

const stubBrowser = {
  navigate: async (url: string) => ({ ok: true as const, value: { url, title: "ok" } }),
  extractLinks: async () => ({ ok: true as const, value: [] as string[] }),
  extractText: async () => ({ ok: true as const, value: "" }),
} as unknown as Browser;

function makeDeps(): { deps: CoordinatorDeps; store: FakeDataStore } {
  const store = new FakeDataStore();
  const deps: CoordinatorDeps = {
    store,
    browser: stubBrowser,
    targetOrigin: "https://example.com",
    maxPages: 10,
    sessionId: "session-1",
    sessionStartedAt: 100,
  };
  return { deps, store };
}

async function executeTool(
  deps: CoordinatorDeps,
  toolName: string,
  args: Record<string, unknown>,
  progress = {
    pagesProcessed: 0,
    scenariosRun: 0,
    featuresDiscoveryRuns: 0,
    signalledDone: false,
    doneReason: "",
    outcome: null,
    stagnantStreak: 0,
    lastProgressSignature: "",
  },
) {
  const tools = buildCoordinatorTools(deps, progress);
  const tool = tools.find((candidate) => candidate.name === toolName);
  expect(tool).toBeDefined();
  return {
    progress,
    result: await tool!.execute("id-1", args, undefined, undefined, {} as never),
  };
}

describe("COORDINATOR_SYSTEM_PROMPT", () => {
  it("mentions every tool name and bans JSON output", () => {
    const prompt = COORDINATOR_SYSTEM_PROMPT;
    for (const name of [
      "navigate",
      "discover_features",
      "author_plan",
      "test",
      "revalidate_feature",
      "invalidate",
      "remove",
      "done",
    ]) {
      expect(prompt).toContain(`${name}(`);
    }
    expect(prompt).toMatch(/Do NOT emit JSON/i);
  });
});

describe("buildFallbackPlan", () => {
  const stats: SitemapStats = { total: 5, discovered: 1, visited: 2, tested: 2 };

  it("covers all six deterministic rungs", () => {
    expect(
      buildFallbackPlan(
        stats,
        [entry("https://example.com/a", "discovered")],
        ["https://example.com/b"],
        [feature(10, "active")],
        [scenario(20)],
        [feature(30, "stale")],
      ),
    ).toEqual({ type: "navigate", url: "https://example.com/a" });

    expect(
      buildFallbackPlan(
        stats,
        [],
        ["https://example.com/b"],
        [feature(10, "active")],
        [scenario(20)],
        [feature(30, "stale")],
      ),
    ).toEqual({ type: "discover_features", url: "https://example.com/b" });

    expect(
      buildFallbackPlan(
        stats,
        [],
        [],
        [feature(10, "active")],
        [scenario(20)],
        [feature(30, "stale")],
      ),
    ).toEqual({ type: "author_plan", featureId: 10 });

    expect(buildFallbackPlan(stats, [], [], [], [scenario(20)], [feature(30, "stale")])).toEqual({
      type: "test",
      scenarioId: 20,
    });

    expect(buildFallbackPlan(stats, [], [], [], [], [feature(30, "stale")])).toEqual({
      type: "revalidate_feature",
      featureId: 30,
    });

    expect(buildFallbackPlan(stats, [], [], [], [], [])).toEqual({
      type: "done",
      reason: "all features verified, all scenarios run",
    });
  });
});

describe("buildCoordinatorTools", () => {
  it("exposes exactly nine tools including fail_session", () => {
    const { deps } = makeDeps();
    const tools = buildCoordinatorTools(deps, {
      pagesProcessed: 0,
      scenariosRun: 0,
      featuresDiscoveryRuns: 0,
      signalledDone: false,
      doneReason: "",
      outcome: null,
      stagnantStreak: 0,
      lastProgressSignature: "",
    });

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "author_plan",
      "discover_features",
      "done",
      "fail_session",
      "invalidate",
      "navigate",
      "remove",
      "revalidate_feature",
      "test",
    ]);
  });

  it("done refuses termination when any work queue is non-empty", async () => {
    const { deps, store } = makeDeps();
    await store.upsertPage({
      url: "https://example.com/a",
      title: "",
      links: [],
      status: "discovered",
    });

    const { progress, result } = await executeTool(deps, "done", { reason: "premature" });

    expect(progress.signalledDone).toBe(false);
    expect((result.details as { overridden?: boolean }).overridden).toBe(true);
    expect(result.terminate).toBeFalsy();
  });

  it("done refuses when scenario cap was reached but unrun scenarios remain", async () => {
    // Regression: applying the per-run scenario cap to the done gate let the
    // coordinator declare completion while the queue still had work, because
    // the cap zeroed `unrunScenarios` for the pending-work check. The fix is
    // that done MUST consult raw state — the cap is a budget on launches, not
    // proof of completion.
    const { deps, store } = makeDeps();
    const created = await store.createFeature({
      name: "feature with one scenario",
      description: "",
      status: "active",
      discoveredBy: "manual",
      urlPatterns: ["https://example.com/feature-1/*"],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const planResult = await store.addTestPlan(created.value.feature.id, {
      createdBy: "planner",
      scenarios: [
        {
          name: "smoke",
          entryUrl: "https://example.com/feature-1/",
          steps: [{ kind: "navigate", url: "https://example.com/feature-1/" }],
          expectedOutcome: "works",
        },
      ],
    });
    expect(planResult.ok).toBe(true);
    if (!planResult.ok) return;

    // Cap=1, already "used" — simulates a finished but unsuccessful test() call.
    const capDeps: CoordinatorDeps = { ...deps, maxScenariosPerRun: 1 };
    const { progress, result } = await executeTool(
      capDeps,
      "done",
      { reason: "cap reached, calling done" },
      {
        pagesProcessed: 0,
        scenariosRun: 1,
        featuresDiscoveryRuns: 0,
        signalledDone: false,
        doneReason: "",
        outcome: null,
        stagnantStreak: 0,
        lastProgressSignature: "",
      },
    );

    expect(progress.signalledDone).toBe(false);
    expect(result.terminate).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("unrunScenarios=1");
    expect(text).toContain("cap reached");
    expect((result.details as { capReached?: boolean }).capReached).toBe(true);
  });

  it("done terminates when all queues are empty", async () => {
    const { deps } = makeDeps();
    const { progress, result } = await executeTool(deps, "done", { reason: "all done" });

    expect(progress.signalledDone).toBe(true);
    expect(progress.doneReason).toBe("all done");
    expect(progress.outcome).toBe("completed");
    expect(result.terminate).toBe(true);
  });

  it("fail_session refuses while pending work remains and stagnation is below limit", async () => {
    const { deps, store } = makeDeps();
    await store.upsertPage({
      url: "https://example.com/a",
      title: "",
      links: [],
      status: "discovered",
    });

    const { progress, result } = await executeTool(deps, "fail_session", {
      reason: "giving up",
    });

    expect(progress.signalledDone).toBe(false);
    expect(progress.outcome).toBeNull();
    expect(result.terminate).toBeFalsy();
    expect((result.details as { refused?: boolean }).refused).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("cannot fail yet");
  });

  it("fail_session terminates once stagnation hits the limit", async () => {
    const { deps, store } = makeDeps();
    await store.upsertPage({
      url: "https://example.com/a",
      title: "",
      links: [],
      status: "discovered",
    });

    const { progress, result } = await executeTool(
      deps,
      "fail_session",
      { reason: "unrecoverable" },
      {
        pagesProcessed: 0,
        scenariosRun: 0,
        featuresDiscoveryRuns: 0,
        signalledDone: false,
        doneReason: "",
        outcome: null,
        stagnantStreak: 8,
        lastProgressSignature: "",
      },
    );

    expect(progress.signalledDone).toBe(true);
    expect(progress.outcome).toBe("failed");
    expect(progress.doneReason).toBe("unrecoverable");
    expect(result.terminate).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("failed");
  });

  it("test(scenarioId) returns not-found text for missing scenarios", async () => {
    const { deps } = makeDeps();
    const { result } = await executeTool(deps, "test", { scenarioId: 999 });

    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toContain("not found");
  });

  it("revalidate_feature retires features that have no url patterns", async () => {
    const { deps, store } = makeDeps();
    const created = await store.createFeature({
      name: "stale feature",
      description: "",
      status: "stale",
      discoveredBy: "manual",
      urlPatterns: ["https://example.com/stale/*"],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const featureId = created.value.feature.id;
    const emptied = await store.updateFeature(featureId, { urlPatterns: [] });
    expect(emptied.ok).toBe(true);

    const { result } = await executeTool(deps, "revalidate_feature", { featureId });
    expect((result.content[0] as { text: string }).text).toContain("retired");

    const reloaded = await store.getFeature(featureId);
    expect(reloaded.ok).toBe(true);
    expect(reloaded.ok && reloaded.value?.feature.status).toBe("retired");
  });
});
