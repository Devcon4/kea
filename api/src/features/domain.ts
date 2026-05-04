import { Err, Ok } from "@kea/shared";
import { normalizeUrl } from "@kea/shared";
import type { Result } from "@kea/shared";
import type {
  Feature,
  FeatureDiscoveredBy,
  FeatureStatus,
  RunDiagnostics,
  Scenario,
  TestPlan,
  TestPlanCreatedBy,
  TestRun,
} from "@kea/shared";

export type CreateScenarioInput = {
  name: string;
  entryUrl: string;
  steps: Scenario["steps"];
  expectedOutcome: string;
};

export type CreateTestPlanInput = {
  createdBy: TestPlanCreatedBy;
  scenarios: CreateScenarioInput[];
};

export type CreateFeatureInput = {
  sessionId: string;
  name: string;
  description: string;
  urlPatterns: string[];
  status: FeatureStatus;
  discoveredBy: FeatureDiscoveredBy;
  discoveredAt: number;
  verifiedAt?: number | null;
};

export type UpdateFeatureInput = {
  status?: FeatureStatus;
  description?: string;
  urlPatterns?: string[];
  verifiedAt?: number | null;
};

export type AddTestPlanResult = {
  plan: Omit<TestPlan, "id">;
  scenarios: Array<Omit<Scenario, "id" | "testPlanId">>;
};

export type AddTestRunInput = {
  startedAt: number;
  completedAt: number;
  result: TestRun["result"];
  stepTrace: TestRun["stepTrace"];
  findingId?: number | null;
  diagnostics?: RunDiagnostics | null;
};

export type ScenarioRunState = "unrun-this-session" | "failed" | "stale";

export type ScenarioRunCandidate = {
  scenario: Scenario;
  featureStatus: FeatureStatus;
  latestRun: TestRun | null;
};

export function createFeature(input: CreateFeatureInput): Result<Omit<Feature, "id">, string> {
  if (!input.sessionId) return Err("sessionId is required");
  if (!input.name.trim()) return Err("Feature name is required");
  if (input.urlPatterns.length < 1) {
    return Err("At least one URL pattern is required");
  }

  return Ok({
    sessionId: input.sessionId,
    name: input.name,
    description: input.description,
    urlPatterns: input.urlPatterns,
    status: input.status,
    discoveredBy: input.discoveredBy,
    discoveredAt: input.discoveredAt,
    verifiedAt: input.verifiedAt ?? null,
  });
}

export function updateFeature(
  feature: Feature,
  patch: UpdateFeatureInput,
): Result<Partial<Feature>, string> {
  if (patch.urlPatterns && patch.urlPatterns.length < 1) {
    return Err("At least one URL pattern is required");
  }

  const next: Partial<Feature> = {};

  if (patch.status !== undefined) next.status = patch.status;
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.urlPatterns !== undefined) next.urlPatterns = patch.urlPatterns;
  if (patch.verifiedAt !== undefined) next.verifiedAt = patch.verifiedAt;

  return Ok(next);
}

export function addTestPlan(
  featureId: number,
  input: CreateTestPlanInput,
  priorActive: TestPlan | undefined,
  now: number,
): Result<AddTestPlanResult, string> {
  if (featureId < 1) return Err("featureId must be positive");
  if (input.scenarios.length < 1) {
    return Err("At least one scenario is required");
  }

  if (priorActive) {
    if (priorActive.featureId !== featureId) {
      return Err("Active test plan does not belong to feature");
    }
    if (priorActive.status !== "active" && priorActive.status !== "needs_revision") {
      return Err("Prior test plan must be active or awaiting revision");
    }
  }

  const revision = priorActive ? priorActive.revision + 1 : 1;

  return Ok({
    plan: {
      featureId,
      revision,
      status: "active",
      verifiedAt: null,
      createdBy: input.createdBy,
      createdAt: now,
      revisionFeedback: null,
    },
    scenarios: input.scenarios.map((scenario) => ({
      name: scenario.name,
      entryUrl: normalizeUrl(scenario.entryUrl),
      steps: scenario.steps,
      expectedOutcome: scenario.expectedOutcome,
      createdAt: now,
    })),
  });
}

export function addTestRun(
  input: AddTestRunInput,
): Result<Omit<TestRun, "id" | "scenarioId">, string> {
  if (input.completedAt < input.startedAt) {
    return Err("completedAt must be greater than or equal to startedAt");
  }

  // Diagnostics only make sense on terminal failure outcomes. Reject runs
  // that smuggle a snapshot under a passing/skipped result so the dashboard
  // never has to defend against "why does this passing run have a
  // screenshot".
  if (input.diagnostics && input.result !== "fail" && input.result !== "error") {
    return Err("diagnostics may only accompany fail/error runs");
  }

  return Ok({
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    result: input.result,
    stepTrace: input.stepTrace,
    findingId: input.findingId ?? null,
    diagnostics: input.diagnostics ?? null,
  });
}

export function selectScenariosToRun(
  candidates: ScenarioRunCandidate[],
  runState: ScenarioRunState,
  since?: number,
): Result<Scenario[], string> {
  if (runState === "unrun-this-session" && since === undefined) {
    return Err("since is required for unrun-this-session");
  }

  const rows = candidates.filter((candidate) => {
    if (runState === "stale") return candidate.featureStatus === "stale";

    if (runState === "failed") {
      return candidate.latestRun?.result === "fail" || candidate.latestRun?.result === "error";
    }

    return !candidate.latestRun || candidate.latestRun.startedAt < (since as number);
  });

  return Ok(rows.map((row) => row.scenario));
}
