import { describe, it, expect } from "vitest";
import {
  CreateFindingSchema,
  CreateSessionSchema,
  UpsertPageSchema,
  VisitPageSchema,
  DiscoverPageSchema,
  UpdateSessionSchema,
  CreateFeatureSchema,
  FeatureSchema,
  UpdateFeatureSchema,
  UrlPatternSchema,
  ScenarioStepSchema,
  ExpectClauseSchema,
  CreateScenarioSchema,
  CreateTestPlanSchema,
  CreateTestRunSchema,
  TestRunResultSchema,
  RerunPolicySchema,
  SessionConfigSchema,
} from "./schemas.js";

describe("schemas", () => {
  describe("UpsertPageSchema", () => {
    it("should validate a valid upsert page input", () => {
      const result = UpsertPageSchema.safeParse({
        url: "http://example.com/",
        title: "Home",
        links: ["http://example.com/about"],
        status: "visited",
      });
      expect(result.success).toBe(true);
    });

    it("should reject invalid status", () => {
      const result = UpsertPageSchema.safeParse({
        url: "http://example.com/",
        title: "Home",
        links: [],
        status: "invalid",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("VisitPageSchema", () => {
    it("should validate a visit page input", () => {
      const result = VisitPageSchema.safeParse({
        url: "http://example.com/",
        title: "Home",
        links: [],
      });
      expect(result.success).toBe(true);
    });
  });

  describe("DiscoverPageSchema", () => {
    it("should validate a discover page input", () => {
      const result = DiscoverPageSchema.safeParse({
        url: "http://example.com/page",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("CreateFindingSchema", () => {
    it("should validate a valid finding", () => {
      const result = CreateFindingSchema.safeParse({
        url: "http://example.com/",
        agentId: "tester-1",
        action: "click button",
        result: "500 error returned",
        severity: "error",
        timestamp: Date.now(),
      });
      expect(result.success).toBe(true);
    });

    it("should reject missing fields", () => {
      const result = CreateFindingSchema.safeParse({
        url: "http://example.com/",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("CreateSessionSchema", () => {
    it("should validate a valid session", () => {
      const result = CreateSessionSchema.safeParse({
        id: "session-abc",
        targetUrl: "http://example.com",
        maxPages: 50,
        startedAt: Date.now(),
      });
      expect(result.success).toBe(true);
    });
  });

  describe("UpdateSessionSchema", () => {
    it("should validate a partial update", () => {
      const result = UpdateSessionSchema.safeParse({
        status: "completed",
        completedAt: Date.now(),
      });
      expect(result.success).toBe(true);
    });

    it("should allow empty update", () => {
      const result = UpdateSessionSchema.safeParse({});
      expect(result.success).toBe(true);
    });
  });

  describe("UrlPatternSchema", () => {
    it("accepts a valid URLPattern", () => {
      const result = UrlPatternSchema.safeParse("https://example.com/products/:id");
      expect(result.success).toBe(true);
    });

    it("rejects nonsense pattern syntax", () => {
      const result = UrlPatternSchema.safeParse("https://example.com/(unclosed");
      expect(result.success).toBe(false);
    });

    it("rejects empty string", () => {
      expect(UrlPatternSchema.safeParse("").success).toBe(false);
    });
  });

  describe("ExpectClauseSchema", () => {
    it.each([
      [{ kind: "equal", value: 42 }],
      [{ kind: "regex", pattern: "^foo", flags: "i" }],
      [{ kind: "semantic", question: "is the cart empty?" }],
    ])("accepts %j", (clause) => {
      expect(ExpectClauseSchema.safeParse(clause).success).toBe(true);
    });

    it("rejects an unknown kind", () => {
      const result = ExpectClauseSchema.safeParse({ kind: "contains", value: "x" });
      expect(result.success).toBe(false);
    });

    it("rejects regex without pattern", () => {
      expect(ExpectClauseSchema.safeParse({ kind: "regex" }).success).toBe(false);
    });
  });

  describe("ScenarioStepSchema", () => {
    it("accepts each kind", () => {
      const steps = [
        { kind: "navigate", url: "/cart" },
        { kind: "act", instruction: "click checkout", verifyWith: "on payment page?" },
        {
          kind: "observe",
          question: "is the total > 0?",
          expect: { kind: "semantic", question: "is the total > 0?" },
        },
        {
          kind: "extract",
          instruction: "the order total",
          schema: { type: "object", properties: { total: { type: "number" } } },
          bind: "order_total",
        },
      ];
      for (const s of steps) {
        expect(ScenarioStepSchema.safeParse(s).success).toBe(true);
      }
    });

    it("requires extract.bind to be a valid identifier when supplied", () => {
      const ok = ScenarioStepSchema.safeParse({
        kind: "extract",
        instruction: "any value",
        schema: {},
        bind: "valid_name1",
      });
      expect(ok.success).toBe(true);
      const bad = ScenarioStepSchema.safeParse({
        kind: "extract",
        instruction: "any value",
        schema: {},
        bind: "1starts-with-digit",
      });
      expect(bad.success).toBe(false);
    });

    it("requires non-empty navigate url and act instruction", () => {
      expect(ScenarioStepSchema.safeParse({ kind: "navigate", url: "" }).success).toBe(false);
      expect(ScenarioStepSchema.safeParse({ kind: "act", instruction: "" }).success).toBe(false);
    });
  });

  describe("CreateScenarioSchema", () => {
    it("accepts a minimal scenario", () => {
      const result = CreateScenarioSchema.safeParse({
        name: "checkout flow",
        entryUrl: "http://example.com/cart",
        steps: [{ kind: "navigate", url: "http://example.com/cart" }],
        expectedOutcome: "reach the confirmation page",
      });
      expect(result.success).toBe(true);
    });

    it("caps steps at the 8-step ceiling", () => {
      const tooMany = Array.from({ length: 9 }, () => ({
        kind: "navigate" as const,
        url: "http://example.com/x",
      }));
      const result = CreateScenarioSchema.safeParse({
        name: "too long",
        entryUrl: "http://example.com/",
        steps: tooMany,
        expectedOutcome: "reach end",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("CreateTestPlanSchema", () => {
    it("accepts a plan with one scenario", () => {
      const result = CreateTestPlanSchema.safeParse({
        scenarios: [
          {
            name: "home loads",
            entryUrl: "http://example.com/",
            steps: [{ kind: "navigate", url: "http://example.com/" }],
            expectedOutcome: "home page renders",
          },
        ],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.createdBy).toBe("manual");
      }
    });
  });

  describe("CreateFeatureSchema", () => {
    it("accepts a feature with a URL pattern", () => {
      const result = CreateFeatureSchema.safeParse({
        name: "shopping cart",
        urlPatterns: ["https://shop.example.com/cart"],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe("active");
        expect(result.data.discoveredBy).toBe("manual");
        expect(result.data.description).toBe("");
      }
    });

    it("rejects a feature with no URL patterns", () => {
      const result = CreateFeatureSchema.safeParse({
        name: "orphan",
        urlPatterns: [],
      });
      expect(result.success).toBe(false);
    });

    it("rejects a malformed URLPattern", () => {
      const result = CreateFeatureSchema.safeParse({
        name: "bad pattern",
        urlPatterns: ["https://example.com/(unclosed"],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("UpdateFeatureSchema", () => {
    it("accepts an empty update", () => {
      expect(UpdateFeatureSchema.safeParse({}).success).toBe(true);
    });

    it("accepts a status flip", () => {
      expect(UpdateFeatureSchema.safeParse({ status: "stale" }).success).toBe(true);
    });
  });

  describe("FeatureSchema", () => {
    it("accepts a fully populated feature row", () => {
      const result = FeatureSchema.safeParse({
        id: 1,
        sessionId: "sess-1",
        name: "cart",
        description: "shopping cart",
        urlPatterns: ["http://example.com/cart"],
        status: "active",
        discoveredBy: "planner",
        discoveredAt: 1,
        verifiedAt: null,
      });
      expect(result.success).toBe(true);
    });
  });

  describe("CreateTestRunSchema", () => {
    it("accepts a run with a step trace", () => {
      const result = CreateTestRunSchema.safeParse({
        startedAt: 1,
        completedAt: 2,
        result: "pass",
        stepTrace: [
          {
            index: 0,
            kind: "navigate",
            args: { url: "http://example.com/" },
            result: "pass",
            evidence: "navigated",
            latencyMs: 12,
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it.each(["pass", "fail", "skipped", "error"] as const)("accepts result=%s", (r) => {
      expect(TestRunResultSchema.safeParse(r).success).toBe(true);
    });
  });

  describe("RerunPolicySchema", () => {
    it("accepts the literal forms", () => {
      expect(RerunPolicySchema.safeParse("full").success).toBe(true);
      expect(RerunPolicySchema.safeParse("stale-only").success).toBe(true);
    });

    it("accepts a duration object", () => {
      expect(RerunPolicySchema.safeParse({ skipIfPassedWithin: "1h" }).success).toBe(true);
    });

    it("rejects a malformed duration", () => {
      expect(RerunPolicySchema.safeParse({ skipIfPassedWithin: "forever" }).success).toBe(false);
    });
  });

  describe("SessionConfigSchema", () => {
    it("applies defaults when fields omitted", () => {
      const result = SessionConfigSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.rerunPolicy).toBe("full");
        expect(result.data.seedFeatures).toEqual([]);
      }
    });

    it("passes through unknown keys for forward compat", () => {
      const result = SessionConfigSchema.safeParse({ headless: false });
      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data as Record<string, unknown>).headless).toBe(false);
      }
    });
  });

  describe("CreateFinding scenarioId", () => {
    it("accepts an optional scenarioId", () => {
      const result = CreateFindingSchema.safeParse({
        url: "http://example.com/",
        agentId: "tester",
        action: "ran scenario",
        result: "step 2 failed",
        severity: "error",
        timestamp: 1,
        scenarioId: 7,
      });
      expect(result.success).toBe(true);
    });
  });
});
