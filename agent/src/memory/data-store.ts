import type { Result } from "../result.js";
import type {
  PageStatus,
  SitemapEntry,
  SitemapStats,
  Severity,
  FindingsStats,
  Feature,
  FeatureStatus,
  FeatureDiscoveredBy,
  RevisionFeedback,
  TestPlan,
  TestPlanCreatedBy,
  Scenario,
  TestRun,
  TestRunResult,
  StepTraceEntry,
  ExpectClause,
  ScenarioStep,
  RerunPolicy,
  SessionConfig,
  SeedFeature,
  Session,
  RunDiagnostics,
} from "@kea/shared";
export { normalizeUrl } from "@kea/shared";
export type {
  PageStatus,
  SitemapEntry,
  SitemapStats,
  Severity,
  FindingsStats,
  Feature,
  FeatureStatus,
  FeatureDiscoveredBy,
  RevisionFeedback,
  TestPlan,
  TestPlanCreatedBy,
  Scenario,
  TestRun,
  TestRunResult,
  StepTraceEntry,
  ExpectClause,
  ScenarioStep,
  RerunPolicy,
  SessionConfig,
  SeedFeature,
  Session,
  RunDiagnostics,
};

export type Finding = {
  id: number;
  url: string;
  agentId: string;
  action: string;
  result: string;
  severity: Severity;
  timestamp: number;
  scenarioId?: number | null;
};

export type UpsertPageInput = {
  url: string;
  title: string;
  links: string[];
  status: PageStatus;
  discoveredAt?: number;
  visitedAt?: number | null;
};

export type AddFindingInput = {
  url: string;
  agentId: string;
  action: string;
  result: string;
  severity: Severity;
  timestamp: number;
  scenarioId?: number;
};

export type AddMessageInput = {
  agentId: string;
  content: string;
  thinking?: string | null;
  timestamp: number;
};

export type CreateScenarioInput = Pick<Scenario, "name" | "entryUrl" | "steps" | "expectedOutcome">;

export type CreateTestPlanInput = {
  createdBy?: TestPlanCreatedBy;
  scenarios: CreateScenarioInput[];
};

export type CreateFeatureInput = {
  name: string;
  description?: string;
  urlPatterns: string[];
  status?: FeatureStatus;
  discoveredBy?: FeatureDiscoveredBy;
  initialPlan?: CreateTestPlanInput;
};

export type UpdateFeatureInput = {
  status?: FeatureStatus;
  description?: string;
  urlPatterns?: string[];
  verifiedAt?: number | null;
};

export type CreateTestRunInput = {
  startedAt: number;
  completedAt: number;
  result: TestRunResult;
  stepTrace: StepTraceEntry[];
  findingId?: number | null;
  diagnostics?: RunDiagnostics | null;
};

/** Binary artifact attached to a TestRun (currently `screenshot`). */
export type TestRunArtifactKind = "screenshot";

export type UploadTestRunArtifactInput = {
  testRunId: number;
  kind: TestRunArtifactKind;
  contentType: string;
  bytes: Uint8Array;
};

export type ActivePlanBundle = {
  plan: TestPlan;
  scenarios: Scenario[];
};

export type FeatureWithActivePlan = {
  feature: Feature;
  activePlan: ActivePlanBundle | null;
};

export type FeatureRevision = {
  plan: TestPlan;
  scenarios: Scenario[];
};

export type FeatureDetail = FeatureWithActivePlan & {
  revisions: FeatureRevision[];
};

export type ScenarioRunState = "unrun-this-session" | "failed" | "stale";

export interface DataStore {
  upsertPage(entry: UpsertPageInput): Promise<Result<void, Error>>;
  visitPage(url: string, title: string, links: string[]): Promise<Result<void, Error>>;
  discoverPage(url: string): Promise<Result<void, Error>>;
  getPage(url: string): Promise<Result<SitemapEntry | null, Error>>;
  getUnvisitedPages(limit?: number): Promise<Result<SitemapEntry[], Error>>;
  getUntestedPages(limit?: number): Promise<Result<SitemapEntry[], Error>>;
  getAllPages(): Promise<Result<SitemapEntry[], Error>>;
  getSitemapStats(): Promise<Result<SitemapStats, Error>>;
  invalidatePage(url: string): Promise<Result<void, Error>>;
  removePage(url: string): Promise<Result<void, Error>>;
  addFinding(finding: AddFindingInput): Promise<Result<number, Error>>;
  getFindings(url?: string): Promise<Result<Finding[], Error>>;
  getFindingsStats(): Promise<Result<FindingsStats, Error>>;
  addMessage(message: AddMessageInput): Promise<Result<number, Error>>;
  getSession(): Promise<Result<Session | null, Error>>;
  createFeature(
    input: CreateFeatureInput,
  ): Promise<Result<{ feature: Feature; activePlan: ActivePlanBundle | null }, Error>>;
  listFeatures(opts?: { status?: FeatureStatus }): Promise<Result<FeatureWithActivePlan[], Error>>;
  getFeature(id: number): Promise<Result<FeatureDetail | null, Error>>;
  updateFeature(id: number, patch: UpdateFeatureInput): Promise<Result<Feature, Error>>;
  addTestPlan(
    featureId: number,
    input: CreateTestPlanInput,
  ): Promise<Result<ActivePlanBundle, Error>>;
  /**
   * Mark an active TestPlan as `needs_revision` so the next coordinator turn
   * routes this feature back to author_plan with the captured verdict. Used
   * exclusively by the tester when an LLM judge classifies a scenario failure
   * as a plan flaw rather than a product failure.
   */
  markPlanNeedsRevision(
    planId: number,
    feedback: RevisionFeedback,
  ): Promise<Result<void, Error>>;
  recordTestRun(scenarioId: number, input: CreateTestRunInput): Promise<Result<TestRun, Error>>;
  uploadTestRunArtifact(input: UploadTestRunArtifactInput): Promise<Result<void, Error>>;
  listScenarios(opts: {
    runState: ScenarioRunState;
    since?: number;
  }): Promise<Result<Scenario[], Error>>;
  close(): void;
}
