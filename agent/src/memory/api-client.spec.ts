import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./api-client.js";

describe("ApiClient feature-driven endpoints", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: ApiClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    client = new ApiClient({ baseUrl: "http://kea.test", sessionId: "session-123" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("createFeature posts to /api/sessions/:id/features and returns payload", async () => {
    const input = {
      name: "Checkout",
      description: "Checkout funnel",
      urlPatterns: ["https://example.com/checkout/*"],
      status: "active" as const,
      discoveredBy: "manual" as const,
      initialPlan: {
        createdBy: "manual" as const,
        scenarios: [
          {
            name: "Complete purchase",
            entryUrl: "https://example.com/checkout",
            steps: [{ kind: "navigate" as const, url: "https://example.com/checkout" }],
            expectedOutcome: "Purchase succeeds",
          },
        ],
      },
    };

    const responseBody = {
      feature: {
        id: 10,
        sessionId: "session-123",
        name: "Checkout",
        description: "Checkout funnel",
        urlPatterns: ["https://example.com/checkout/*"],
        status: "active",
        discoveredBy: "manual",
        discoveredAt: 100,
        verifiedAt: null,
      },
      activePlan: {
        plan: {
          id: 20,
          featureId: 10,
          revision: 1,
          status: "active",
          verifiedAt: null,
          createdBy: "manual",
          createdAt: 100,
        },
        scenarios: [
          {
            id: 30,
            testPlanId: 20,
            name: "Complete purchase",
            entryUrl: "https://example.com/checkout",
            steps: [{ kind: "navigate", url: "https://example.com/checkout" }],
            expectedOutcome: "Purchase succeeds",
            createdAt: 100,
          },
        ],
      },
    };

    fetchMock.mockResolvedValue(jsonResponse(responseBody));

    const result = await client.createFeature(input);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://kea.test/api/sessions/session-123/features");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(input);
    expect(result).toEqual({ ok: true, value: responseBody });
  });

  it("createFeature returns Err with status on non-ok response", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "conflict" }, 409));

    const result = await client.createFeature({
      name: "Checkout",
      urlPatterns: ["https://example.com/checkout/*"],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("409");
    }
  });

  it("listFeatures sends status query when provided", async () => {
    const responseBody = [
      {
        id: 10,
        sessionId: "session-123",
        name: "Checkout",
        description: "Checkout funnel",
        urlPatterns: ["https://example.com/checkout/*"],
        status: "active",
        discoveredBy: "manual",
        discoveredAt: 100,
        verifiedAt: null,
        activePlan: null,
      },
    ];

    fetchMock.mockResolvedValue(jsonResponse(responseBody));

    const result = await client.listFeatures({ status: "active" });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("http://kea.test/api/sessions/session-123/features?status=active");
    expect(result).toEqual({ ok: true, value: responseBody });
  });

  it("listFeatures omits query params when status is not provided", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));

    await client.listFeatures();

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("http://kea.test/api/sessions/session-123/features");
  });

  it("addTestPlan posts to /api/features/:id/test-plans", async () => {
    const input = {
      createdBy: "manual" as const,
      scenarios: [
        {
          name: "Reset password",
          entryUrl: "https://example.com/login",
          steps: [{ kind: "navigate" as const, url: "https://example.com/login" }],
          expectedOutcome: "Reset email sent",
        },
      ],
    };
    const responseBody = {
      plan: {
        id: 21,
        featureId: 10,
        revision: 2,
        status: "active",
        verifiedAt: null,
        createdBy: "manual",
        createdAt: 200,
      },
      scenarios: [
        {
          id: 31,
          testPlanId: 21,
          name: "Reset password",
          entryUrl: "https://example.com/login",
          steps: [{ kind: "navigate", url: "https://example.com/login" }],
          expectedOutcome: "Reset email sent",
          createdAt: 200,
        },
      ],
    };

    fetchMock.mockResolvedValue(jsonResponse(responseBody));

    const result = await client.addTestPlan(10, input);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://kea.test/api/features/10/test-plans");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(input);
    expect(result).toEqual({ ok: true, value: responseBody });
  });

  it("recordTestRun posts to /api/scenarios/:id/runs", async () => {
    const input = {
      startedAt: 100,
      completedAt: 200,
      result: "pass" as const,
      stepTrace: [
        {
          index: 0,
          kind: "navigate" as const,
          args: { url: "https://example.com" },
          result: "pass" as const,
          evidence: "loaded",
          latencyMs: 50,
        },
      ],
      findingId: 41,
    };

    const responseBody = {
      id: 50,
      scenarioId: 31,
      startedAt: 100,
      completedAt: 200,
      result: "pass",
      stepTrace: input.stepTrace,
      findingId: 41,
    };

    fetchMock.mockResolvedValue(jsonResponse(responseBody));

    const result = await client.recordTestRun(31, input);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://kea.test/api/scenarios/31/runs");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(input);
    expect(result).toEqual({ ok: true, value: responseBody });
  });

  it("listScenarios sends runState and since query params", async () => {
    const responseBody = [
      {
        id: 31,
        testPlanId: 21,
        name: "Reset password",
        entryUrl: "https://example.com/login",
        steps: [{ kind: "navigate", url: "https://example.com/login" }],
        expectedOutcome: "Reset email sent",
        createdAt: 200,
      },
    ];

    fetchMock.mockResolvedValue(jsonResponse(responseBody));

    const result = await client.listScenarios({
      runState: "unrun-this-session",
      since: 1710000000000,
    });

    const [url] = fetchMock.mock.calls[0] as [string];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/sessions/session-123/scenarios");
    expect(parsed.searchParams.get("runState")).toBe("unrun-this-session");
    expect(parsed.searchParams.get("since")).toBe("1710000000000");
    expect(result).toEqual({ ok: true, value: responseBody });
  });

  it("addFinding forwards optional scenarioId", async () => {
    const input = {
      url: "https://example.com/login",
      agentId: "tester",
      action: "observe",
      result: "Login button missing",
      severity: "error" as const,
      timestamp: 123,
      scenarioId: 31,
    };

    fetchMock.mockResolvedValue(jsonResponse({ id: 77 }));

    const result = await client.addFinding(input);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://kea.test/api/sessions/session-123/findings");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(input);
    expect(result).toEqual({ ok: true, value: 77 });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
