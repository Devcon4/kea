import { describe, expect, it, vi } from "vitest";
import type { Scenario, ScenarioStep, TestRun } from "@kea/shared";
import { Ok, Err } from "../result.js";
import { FakeDataStore } from "../pi/test-harness.js";
import type { AddFindingInput, CreateTestRunInput, RevisionFeedback } from "../memory/data-store.js";
import { Browser as StagehandBrowser } from "../browser/stagehand.js";
import type { Browser } from "../browser/stagehand.js";
import { runTester } from "./tester.js";
import type { SemanticJudge } from "./tester.js";

const ollamaBaseUrl = (process.env.LLM_BASE_URL ?? "http://localhost:11434/v1").replace(/\/+$/, "");
const blogBaseUrl = "http://localhost:3000";

class RecordingDataStore extends FakeDataStore {
  readonly testRuns: TestRun[] = [];
  readonly markedPlanRevisions: Array<{ planId: number; feedback: RevisionFeedback }> = [];
  failRecordTestRun = false;
  failAddFinding = false;
  private nextRecordedRunId = 1;

  override async addFinding(input: AddFindingInput) {
    if (this.failAddFinding) {
      return Err(new Error("forced addFinding failure"));
    }

    return super.addFinding(input);
  }

  override async markPlanNeedsRevision(planId: number, feedback: RevisionFeedback) {
    this.markedPlanRevisions.push({ planId, feedback: { ...feedback } });
    return Ok(undefined);
  }

  override async recordTestRun(scenarioId: number, input: CreateTestRunInput) {
    if (this.failRecordTestRun) {
      return Err(new Error("forced recordTestRun failure"));
    }

    const run: TestRun = {
      id: this.nextRecordedRunId++,
      scenarioId,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      result: input.result,
      stepTrace: input.stepTrace,
      findingId: input.findingId ?? null,
      diagnostics: input.diagnostics ?? null,
    };
    this.testRuns.push(run);
    return Ok(run);
  }
}

function makeScenario(steps: ScenarioStep[], id = 1): Scenario {
  return {
    id,
    testPlanId: 1,
    name: `scenario-${id}`,
    entryUrl: "https://example.com/start",
    steps,
    expectedOutcome: "works",
    createdAt: 1,
  };
}

type BrowserResult<T> = { ok: true; value: T } | { ok: false; error: Error };

function makeBrowserMock() {
  let currentUrl = "https://example.com/start";

  const navigate = vi.fn<(url: string) => Promise<BrowserResult<{ url: string; title: string }>>>(
    async (url: string) => {
      currentUrl = url;
      return Ok({ url, title: `title:${url}` });
    },
  );

  const act = vi.fn<
    (instruction: string) => Promise<BrowserResult<{ success: boolean; description: string }>>
  >(async () =>
    Ok({
      success: true,
      description: "act succeeded",
    }),
  );

  const extract = vi.fn<(instruction: string, schema: unknown) => Promise<BrowserResult<unknown>>>(
    async () => Ok({ answer: "yes" }),
  );

  const observe = vi.fn<(instruction: string) => Promise<BrowserResult<unknown[]>>>(async () =>
    Ok([]),
  );

  const currentUrlFn = vi.fn(() => currentUrl);
  const pageTitle = vi.fn(async () => Ok("mock title"));
  const extractText = vi.fn(async () => Ok("mock visible page text"));

  const browser = {
    navigate,
    act,
    extract,
    observe,
    pageTitle,
    extractText,
    currentUrl: currentUrlFn,
    // Tester invokes these on every run; happy-path mocks return success
    // shapes so unit tests don't need to wire diagnostics each time.
    resetDiagnostics: vi.fn(async () => {}),
    captureDiagnostics: vi.fn(async () =>
      Ok({
        diagnostics: {
          failingStepIndex: null,
          pageUrl: currentUrl,
          pageTitle: "",
          domSnippet: "",
          domTruncated: false,
          consoleMessages: [],
          pageErrors: [],
          networkFailures: [],
          llmFailures: [],
          capturedAt: 0,
        },
        screenshot: null,
      }),
    ),
  } as unknown as Browser;

  return {
    browser,
    navigate,
    act,
    extract,
    observe,
    currentUrlFn,
    setCurrentUrl: (url: string) => {
      currentUrl = url;
    },
  };
}

async function probe(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Build an Observer that returns the supplied answers one at a time. Tests
 * use this to inject deterministic observer outputs without spinning up a
 * Pi session, mirroring how `judge` is injected.
 */
function makeObserver(...answers: string[]) {
  let index = 0;
  const fn = vi.fn(async () => {
    if (index >= answers.length) {
      return { ok: false as const, error: `observer ran out of answers (called ${index + 1} times)` };
    }
    const answer = answers[index++];
    return { ok: true as const, answer };
  });
  return fn;
}

describe("runTester step interpreter", () => {
  it("passes happy-path scenario and records run trace without finding", async () => {
    const store = new RecordingDataStore();
    const browserMock = makeBrowserMock();
    const scenario = makeScenario([
      { kind: "navigate", url: "https://example.com/start" },
      {
        kind: "observe",
        question: "Is the page ready?",
        expect: { kind: "regex", pattern: "yes", flags: "i" },
      },
      { kind: "act", instruction: "Click continue", verifyWith: "Did the click succeed?" },
      {
        kind: "extract",
        instruction: "the primary CTA label",
        schema: {
          type: "object",
          properties: { cta: { type: "string" } },
          required: ["cta"],
        },
        expect: { kind: "equal", value: { cta: "Checkout" } },
      },
    ]);

    browserMock.extract
      .mockResolvedValueOnce(Ok({ answer: "yes" }))
      .mockResolvedValueOnce(Ok({ cta: "Checkout" }));
    const observer = makeObserver("yes");

    const result = await runTester({ scenario, browser: browserMock.browser, store, observer });

    expect(result).toEqual({ result: "pass", runId: 1, findingId: null });
    expect(store.findings).toHaveLength(0);
    expect(store.testRuns).toHaveLength(1);
    expect(store.testRuns[0].stepTrace.map((entry) => entry.result)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
  });

  it("substitutes ${binding} placeholders from extract.bind outputs", async () => {
    const store = new RecordingDataStore();
    const browserMock = makeBrowserMock();
    const scenario = makeScenario([
      {
        kind: "extract",
        instruction: "the post slug",
        schema: { type: "string" },
        bind: "slug",
      },
      {
        kind: "navigate",
        url: "https://example.com/posts/${slug}",
      },
    ]);

    browserMock.extract.mockResolvedValueOnce(Ok("hello-world"));

    const result = await runTester({ scenario, browser: browserMock.browser, store });

    expect(result.result).toBe("pass");
    expect(browserMock.navigate).toHaveBeenCalledWith("https://example.com/posts/hello-world");
    expect(store.testRuns[0].stepTrace[1].args).toEqual({
      url: "https://example.com/posts/hello-world",
    });
  });

  it("leaves unresolved placeholders literal when no binding exists", async () => {
    const store = new RecordingDataStore();
    const browserMock = makeBrowserMock();
    const scenario = makeScenario([
      {
        kind: "navigate",
        url: "https://example.com/${missing}",
      },
    ]);

    browserMock.navigate.mockImplementationOnce(async (url: string) => {
      if (url.includes("${missing}")) {
        return Err(new Error("invalid unresolved placeholder"));
      }
      return Ok({ url, title: "ok" });
    });

    const result = await runTester({ scenario, browser: browserMock.browser, store });

    expect(result.result).toBe("fail");
    expect(store.testRuns[0].stepTrace[0].args).toEqual({
      url: "https://example.com/${missing}",
    });
  });

  it("retries act once with rephrased instruction and can still pass", async () => {
    const store = new RecordingDataStore();
    const browserMock = makeBrowserMock();
    const scenario = makeScenario([{ kind: "act", instruction: "Submit form" }]);

    browserMock.act
      .mockResolvedValueOnce(
        Ok({
          success: false,
          description: "first attempt failed",
        }),
      )
      .mockResolvedValueOnce(
        Ok({
          success: true,
          description: "second attempt succeeded",
        }),
      );

    const result = await runTester({ scenario, browser: browserMock.browser, store });

    expect(result.result).toBe("pass");
    expect(browserMock.act).toHaveBeenCalledTimes(2);
    expect(browserMock.act.mock.calls[1][0]).toBe("Try a different approach: Submit form");
  });

  it("fails after persistent act failure and emits error-severity finding", async () => {
    const store = new RecordingDataStore();
    const browserMock = makeBrowserMock();
    const scenario = makeScenario([{ kind: "act", instruction: "Open menu" }]);

    browserMock.act
      .mockResolvedValueOnce(Ok({ success: false, description: "no-op" }))
      .mockResolvedValueOnce(Ok({ success: false, description: "still no-op" }));

    const result = await runTester({ scenario, browser: browserMock.browser, store });

    expect(result.result).toBe("fail");
    expect(result.findingId).toBe(1);
    expect(store.findings).toHaveLength(1);
    expect(store.findings[0].severity).toBe("error");
    expect(store.findings[0].scenarioId).toBe(scenario.id);
  });

  it("short-circuits at first failing step and omits remaining steps", async () => {
    const store = new RecordingDataStore();
    const browserMock = makeBrowserMock();
    const scenario = makeScenario([
      { kind: "navigate", url: "https://example.com/a" },
      {
        kind: "observe",
        question: "Did we reach account page?",
        expect: { kind: "equal", value: "yes" },
      },
      { kind: "act", instruction: "This should not run" },
    ]);

    const observer = makeObserver("no");

    const result = await runTester({ scenario, browser: browserMock.browser, store, observer });

    expect(result.result).toBe("fail");
    expect(browserMock.act).not.toHaveBeenCalled();
    expect(store.testRuns[0].stepTrace).toHaveLength(2);
    expect(store.testRuns[0].stepTrace[1].index).toBe(2);
    expect(store.testRuns[0].stepTrace[1].result).toBe("fail");
  });


  it(
    "flawJudge=scenario_flawed marks plan needs_revision and suppresses finding",
    async () => {
      const store = new RecordingDataStore();
      const browserMock = makeBrowserMock();
      const scenario = makeScenario([{ kind: "act", instruction: "Open menu" }]);

      browserMock.act
        .mockResolvedValueOnce(Ok({ success: false, description: "no-op" }))
        .mockResolvedValueOnce(Ok({ success: false, description: "still no-op" }));

      const flawJudge = vi.fn(async () => ({
        kind: "scenario_flawed" as const,
        reason: "missing_element" as const,
        diagnosis: "the menu trigger does not exist on this page",
      }));

      const result = await runTester({
        scenario,
        browser: browserMock.browser,
        store,
        flawJudge,
      });

      expect(result.result).toBe("fail");
      expect(result.findingId).toBeNull();
      expect(store.findings).toHaveLength(0);
      expect(flawJudge).toHaveBeenCalledTimes(1);
      expect(store.markedPlanRevisions).toHaveLength(1);
      expect(store.markedPlanRevisions[0]).toMatchObject({
        planId: scenario.testPlanId,
        feedback: {
          reason: "missing_element",
          diagnosis: "the menu trigger does not exist on this page",
          rejectedByRunId: store.testRuns[0].id,
          failingStepIndex: 1,
        },
      });
    },
  );

  it("flawJudge=product_failure preserves the existing finding emission", async () => {
    const store = new RecordingDataStore();
    const browserMock = makeBrowserMock();
    const scenario = makeScenario([{ kind: "act", instruction: "Open menu" }]);

    browserMock.act
      .mockResolvedValueOnce(Ok({ success: false, description: "no-op" }))
      .mockResolvedValueOnce(Ok({ success: false, description: "still no-op" }));

    const flawJudge = vi.fn(async () => ({ kind: "product_failure" as const }));

    const result = await runTester({
      scenario,
      browser: browserMock.browser,
      store,
      flawJudge,
    });

    expect(result.result).toBe("fail");
    expect(result.findingId).toBe(1);
    expect(store.findings).toHaveLength(1);
    expect(store.markedPlanRevisions).toHaveLength(0);
    expect(flawJudge).toHaveBeenCalledTimes(1);
  });

  it("records thrown browser exceptions as error with warning finding", async () => {
    const store = new RecordingDataStore();
    const browserMock = makeBrowserMock();
    const scenario = makeScenario([{ kind: "navigate", url: "https://example.com/crash" }]);

    browserMock.navigate.mockRejectedValueOnce(new Error("browser disconnected"));

    const result = await runTester({ scenario, browser: browserMock.browser, store });

    expect(result.result).toBe("error");
    expect(store.findings).toHaveLength(1);
    expect(store.findings[0].severity).toBe("warning");
    expect(store.testRuns[0].stepTrace[0].result).toBe("error");
    expect(store.testRuns[0].stepTrace[0].evidence).toContain("browser disconnected");
  });

  it("terminates with error on sixth page transition", async () => {
    const store = new RecordingDataStore();
    const browserMock = makeBrowserMock();
    const steps: ScenarioStep[] = [
      { kind: "navigate", url: "https://example.com/1" },
      { kind: "navigate", url: "https://example.com/2" },
      { kind: "navigate", url: "https://example.com/3" },
      { kind: "navigate", url: "https://example.com/4" },
      { kind: "navigate", url: "https://example.com/5" },
      { kind: "navigate", url: "https://example.com/6" },
    ];
    const scenario = makeScenario(steps);

    const result = await runTester({ scenario, browser: browserMock.browser, store });

    expect(result.result).toBe("error");
    expect(store.testRuns[0].stepTrace).toHaveLength(6);
    expect(store.testRuns[0].stepTrace[5].result).toBe("error");
    expect(store.testRuns[0].stepTrace[5].evidence).toContain("page transition cap exceeded");
  });

  it("evaluates semantic assertions via injected judge (yes/no)", async () => {
    const passStore = new RecordingDataStore();
    const failStore = new RecordingDataStore();
    const passBrowser = makeBrowserMock();
    const failBrowser = makeBrowserMock();
    const scenario = makeScenario([
      {
        kind: "observe",
        question: "Does the answer satisfy policy?",
        expect: { kind: "semantic", question: "Is this acceptable?" },
      },
    ]);

    const passObserver = makeObserver("looks acceptable");
    const failObserver = makeObserver("clearly unacceptable");

    const yesJudgeMock = vi.fn(async () => true);
    const noJudgeMock = vi.fn(async () => false);
    const yesJudge: SemanticJudge = yesJudgeMock;
    const noJudge: SemanticJudge = noJudgeMock;

    const passResult = await runTester({
      scenario,
      browser: passBrowser.browser,
      store: passStore,
      judge: yesJudge,
      observer: passObserver,
    });
    const failResult = await runTester({
      scenario,
      browser: failBrowser.browser,
      store: failStore,
      judge: noJudge,
      observer: failObserver,
    });

    expect(passResult.result).toBe("pass");
    expect(failResult.result).toBe("fail");
    expect(yesJudgeMock).toHaveBeenCalledTimes(1);
    expect(noJudgeMock).toHaveBeenCalledTimes(1);
  });

  it("coerces yes/no string answers to booleans for equal: true/false", async () => {
    const browserMock = makeBrowserMock();
    const scenario = makeScenario([
      {
        kind: "observe",
        question: "is the search input visible?",
        expect: { kind: "equal", value: true },
      },
    ]);

    const cases: { answer: string; expectPass: boolean }[] = [
      { answer: "Yes, a list of blog posts is visible.", expectPass: true },
      { answer: "yes", expectPass: true },
      { answer: "True", expectPass: true },
      { answer: "no, the search input is hidden", expectPass: false },
      { answer: "null", expectPass: false },
      { answer: "Our Products \u2014 Kea Shop", expectPass: false },
    ];

    for (const { answer, expectPass } of cases) {
      const store = new RecordingDataStore();
      const observer = makeObserver(answer);
      const result = await runTester({ scenario, browser: browserMock.browser, store, observer });
      expect(result.result, `answer=${answer}`).toBe(expectPass ? "pass" : "fail");
    }
  });

  it("preserves run result when recordTestRun returns Err", async () => {
    const store = new RecordingDataStore();
    store.failRecordTestRun = true;
    const browserMock = makeBrowserMock();
    const scenario = makeScenario([{ kind: "act", instruction: "Break" }]);

    browserMock.act
      .mockResolvedValueOnce(Ok({ success: false, description: "fail-1" }))
      .mockResolvedValueOnce(Ok({ success: false, description: "fail-2" }));

    const result = await runTester({ scenario, browser: browserMock.browser, store });

    expect(result.result).toBe("fail");
    expect(result.runId).toBeNull();
    expect(result.findingId).toBe(1);
  });
});

describe("runTester live (ollama + blog gated)", () => {
  it(
    "runs end-to-end against local blog when prerequisites are reachable",
    { timeout: 120_000 },
    async () => {
      const ollamaReachable = await probe(`${ollamaBaseUrl}/models`);
      const blogReachable = await probe(blogBaseUrl);

      if (!ollamaReachable || !blogReachable) {
        console.warn("ollama or blog unavailable; skipping runTester live test");
        return;
      }

      const browser = new StagehandBrowser();
      await browser.launch({ headless: true, timeout: 10_000 });

      const store = new RecordingDataStore();
      const scenario = makeScenario(
        [
          { kind: "navigate", url: blogBaseUrl },
          {
            kind: "observe",
            question: "What page is this?",
            expect: {
              kind: "semantic",
              question: "Is this a blog page with readable article or index content?",
            },
          },
        ],
        99,
      );

      try {
        const result = await runTester({ scenario, browser, store });
        expect(result.runId).not.toBeNull();
        expect(["pass", "fail", "error"]).toContain(result.result);
        expect(store.testRuns.at(-1)?.stepTrace.length).toBeGreaterThan(0);
      } finally {
        await browser.close();
      }
    },
  );
});
