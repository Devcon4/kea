import { beforeEach, describe, expect, it, vi } from "vitest";
import { Err, Ok } from "../result.js";
import type {
  ActivePlanBundle,
  DataStore,
  Feature,
  FeatureDetail,
  FeatureWithActivePlan,
  TestPlan,
} from "../memory/data-store.js";
import type { Browser } from "../browser/stagehand.js";

vi.mock("../pi/session.js", () => ({
  createKeaSession: vi.fn(),
}));

vi.mock("../pi/bridge.js", () => ({
  bridgeSessionToStore: vi.fn(() => vi.fn()),
}));

import { createKeaSession } from "../pi/session.js";
import { bridgeSessionToStore } from "../pi/bridge.js";
import { runPlannerAuthor, runPlannerDiscover } from "./planner.js";

type PlannerTool = {
  name: string;
  execute: (...args: unknown[]) => Promise<{ details?: Record<string, unknown> }>;
};

const createKeaSessionMock = vi.mocked(createKeaSession);
const bridgeSessionToStoreMock = vi.mocked(bridgeSessionToStore);

function makeFeature(id: number, name: string, urlPatterns: string[]): Feature {
  return {
    id,
    sessionId: "session-1",
    name,
    description: "desc",
    urlPatterns,
    status: "active",
    discoveredBy: "planner",
    discoveredAt: Date.now(),
    verifiedAt: null,
  };
}

function makeFeatureWithActivePlan(
  id: number,
  name: string,
  urlPatterns: string[],
): FeatureWithActivePlan {
  return {
    feature: makeFeature(id, name, urlPatterns),
    activePlan: null,
  };
}

function makePlan(featureId: number, revision: number, status: TestPlan["status"]): TestPlan {
  return {
    id: revision * 10,
    featureId,
    revision,
    status,
    verifiedAt: null,
    createdBy: "planner",
    createdAt: Date.now(),
    revisionFeedback: null,
  };
}

function makeFeatureDetail(
  featureId: number,
  urlPatterns: string[],
  revisions: Array<{ revision: number; status: TestPlan["status"] }>,
): FeatureDetail {
  const planRevisions = revisions.map((r) => ({
    plan: makePlan(featureId, r.revision, r.status),
    scenarios: [],
  }));
  const active = planRevisions.find(({ plan }) => plan.status === "active") ?? null;
  return {
    feature: makeFeature(featureId, "Search", urlPatterns),
    activePlan: active,
    revisions: planRevisions,
  };
}

function makeBrowser(overrides?: Partial<Browser>): Browser {
  return {
    navigate: vi.fn(async (url: string) => Ok({ url, title: "Example" })),
    observe: vi.fn().mockResolvedValue(Ok([])),
    extract: vi.fn().mockResolvedValue(Ok({})),
    ...overrides,
  } as unknown as Browser;
}

function makeStore(overrides?: Partial<DataStore>): DataStore {
  return {
    listFeatures: vi.fn().mockResolvedValue(Ok([])),
    createFeature: vi.fn().mockResolvedValue(
      Ok({
        feature: makeFeature(100, "New Feature", ["https://example.com/*"]),
        activePlan: null,
      }),
    ),
    getFeature: vi.fn().mockResolvedValue(Ok(makeFeatureDetail(1, ["https://example.com/"], []))),
    updateFeature: vi
      .fn()
      .mockResolvedValue(Ok(makeFeature(1, "Search", ["https://example.com/"]))),
    addTestPlan: vi.fn().mockResolvedValue(
      Ok({
        plan: makePlan(1, 2, "active"),
        scenarios: [
          {
            id: 21,
            testPlanId: 20,
            name: "Scenario",
            entryUrl: "https://example.com/",
            expectedOutcome: "done",
            steps: [{ kind: "navigate", url: "https://example.com/" }],
            createdAt: Date.now(),
          },
        ],
      } satisfies ActivePlanBundle),
    ),
    ...overrides,
  } as unknown as DataStore;
}

function setupKeaSession(script: (tools: PlannerTool[]) => Promise<void> | void): void {
  createKeaSessionMock.mockImplementationOnce(async ({ tools }) => {
    const session = {
      prompt: vi.fn(async () => {
        await script(tools as unknown as PlannerTool[]);
      }),
    };

    return {
      session: session as never,
      model: {} as never,
      llmEnv: {} as never,
      dispose: vi.fn(),
    };
  });
}

async function invokeTool(
  tools: PlannerTool[],
  name: string,
  args: Record<string, unknown>,
): Promise<{ details?: Record<string, unknown> }> {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.execute("tool-id", args, undefined, undefined, {} as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  bridgeSessionToStoreMock.mockReturnValue(vi.fn());
});

describe("runPlannerDiscover", () => {
  it("records a new feature in the happy path", async () => {
    const browser = makeBrowser();
    const store = makeStore({
      listFeatures: vi.fn().mockResolvedValue(Ok([])),
      createFeature: vi.fn().mockResolvedValue(
        Ok({
          feature: makeFeature(11, "Search", ["https://example.com/search/*"]),
          activePlan: null,
        }),
      ),
    });

    setupKeaSession(async (tools) => {
      await invokeTool(tools, "record_feature", {
        name: "Search",
        description: "Find content",
        urlPatterns: ["https://example.com/search/*"],
      });
    });

    const result = await runPlannerDiscover({
      url: "https://example.com/search/results",
      browser,
      store,
      sessionId: "session-1",
    });

    expect(result).toEqual({ featuresAdded: 1, featuresLinked: 0 });
    expect(store.createFeature).toHaveBeenCalledTimes(1);
    expect(store.createFeature).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Search", discoveredBy: "planner" }),
    );
  });

  it("reuses an existing feature when URL patterns overlap", async () => {
    const browser = makeBrowser();
    const existing = makeFeatureWithActivePlan(7, "Search", ["https://example.com/search/*"]);
    const store = makeStore({
      listFeatures: vi.fn().mockResolvedValue(Ok([existing])),
      createFeature: vi.fn(),
    });

    let toolResult: unknown = null;
    setupKeaSession(async (tools) => {
      toolResult = await invokeTool(tools, "record_feature", {
        name: "Find",
        description: "search results",
        urlPatterns: ["https://example.com/search/results"],
      });
    });

    const result = await runPlannerDiscover({
      url: "https://example.com/search/results",
      browser,
      store,
      sessionId: "session-1",
    });

    expect(result).toEqual({ featuresAdded: 0, featuresLinked: 0 });
    expect(store.createFeature).not.toHaveBeenCalled();
    if (!toolResult || typeof toolResult !== "object") throw new Error("expected tool result");
    expect((toolResult as { details?: Record<string, unknown> }).details).toMatchObject({
      reused: true,
      reason: "pattern-overlap",
      featureId: 7,
    });
  });

  it("halts tool effects once the discover budget is exhausted", async () => {
    const browser = makeBrowser({ observe: vi.fn().mockResolvedValue(Ok([])) });
    const store = makeStore();

    let seventhCall: unknown = null;
    setupKeaSession(async (tools) => {
      for (let i = 0; i < 7; i++) {
        const result = await invokeTool(tools, "browser_observe", { question: `q-${i}` });
        if (i === 6) seventhCall = result;
      }
    });

    const result = await runPlannerDiscover({
      url: "https://example.com/",
      browser,
      store,
      sessionId: "session-1",
    });

    expect(result).toEqual({ featuresAdded: 0, featuresLinked: 0 });
    expect(browser.observe).toHaveBeenCalledTimes(6);
    if (!seventhCall || typeof seventhCall !== "object") {
      throw new Error("expected seventh tool result");
    }
    expect((seventhCall as { details?: Record<string, unknown> }).details).toMatchObject({
      budgetExhausted: true,
      error: "budget exhausted",
    });
  });

  it("returns zero summary when an internal throw occurs", async () => {
    const browser = makeBrowser({
      navigate: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const store = makeStore();

    const result = await runPlannerDiscover({
      url: "https://example.com/",
      browser,
      store,
      sessionId: "session-1",
    });

    expect(result).toEqual({ featuresAdded: 0, featuresLinked: 0 });
  });
});

describe("runPlannerAuthor", () => {
  it("short-circuits when an active plan already exists", async () => {
    const browser = makeBrowser();
    const store = makeStore({
      getFeature: vi
        .fn()
        .mockResolvedValue(
          Ok(
            makeFeatureDetail(
              10,
              ["https://example.com/account"],
              [{ revision: 3, status: "active" }],
            ),
          ),
        ),
      addTestPlan: vi.fn(),
    });

    const result = await runPlannerAuthor({ featureId: 10, browser, store });

    expect(result).toEqual({ scenariosAdded: 0, planRevision: 3 });
    expect(createKeaSessionMock).not.toHaveBeenCalled();
    expect(store.addTestPlan).not.toHaveBeenCalled();
    expect(browser.navigate).not.toHaveBeenCalled();
  });

  it("records buffered scenarios via addTestPlan", async () => {
    const browser = makeBrowser({
      navigate: vi
        .fn()
        .mockResolvedValue(Ok({ url: "https://example.com/account", title: "Account" })),
    });
    const store = makeStore({
      getFeature: vi
        .fn()
        .mockResolvedValue(
          Ok(
            makeFeatureDetail(
              10,
              ["https://example.com/account"],
              [{ revision: 1, status: "superseded" }],
            ),
          ),
        ),
      addTestPlan: vi.fn().mockResolvedValue(
        Ok({
          plan: makePlan(10, 2, "active"),
          scenarios: [
            {
              id: 200,
              testPlanId: 20,
              name: "Login works",
              entryUrl: "https://example.com/account",
              steps: [
                { kind: "navigate", url: "https://example.com/account" },
                {
                  kind: "observe",
                  question: "Is sign-in visible?",
                  expect: { kind: "regex", pattern: "yes" },
                },
              ],
              expectedOutcome: "User can sign in",
              createdAt: Date.now(),
            },
          ],
        } satisfies ActivePlanBundle),
      ),
    });

    setupKeaSession(async (tools) => {
      await invokeTool(tools, "record_scenario", {
        name: "Login works",
        entryUrl: "https://example.com/account",
        steps: [
          { kind: "navigate", url: "https://example.com/account" },
          {
            kind: "observe",
            question: "Is sign-in visible?",
            expect: { kind: "regex", pattern: "yes" },
          },
        ],
        expectedOutcome: "User can sign in",
      });
    });

    const result = await runPlannerAuthor({ featureId: 10, browser, store });

    expect(result).toEqual({ scenariosAdded: 1, planRevision: 2 });
    expect(store.addTestPlan).toHaveBeenCalledTimes(1);
    expect(store.addTestPlan).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        createdBy: "planner",
        scenarios: expect.arrayContaining([
          expect.objectContaining({ name: "Login works", entryUrl: "https://example.com/account" }),
        ]),
      }),
    );
  });

  it("returns zero summary when an internal throw occurs", async () => {
    const browser = makeBrowser();
    const store = makeStore({
      getFeature: vi.fn().mockRejectedValue(new Error("read failed")),
    });

    const result = await runPlannerAuthor({ featureId: 44, browser, store });

    expect(result).toEqual({ scenariosAdded: 0, planRevision: null });
  });
});
