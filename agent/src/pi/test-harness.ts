import { vi } from "vitest";
import { Ok, Err } from "../result.js";
import type { Result } from "../result.js";
import type {
  ActivePlanBundle,
  AddFindingInput,
  AddMessageInput,
  CreateFeatureInput,
  CreateTestPlanInput,
  CreateTestRunInput,
  DataStore,
  Feature,
  FeatureDetail,
  FeatureStatus,
  FeatureWithActivePlan,
  Finding,
  FindingsStats,
  RevisionFeedback,
  Scenario,
  SitemapEntry,
  SitemapStats,
  TestPlan,
  TestRun,
  UpsertPageInput,
  UpdateFeatureInput,
  Session,
} from "../memory/data-store.js";

/**
 * In-memory `DataStore` implementation for unit tests. Records calls so tests
 * can assert against them without a Postgres dependency.
 */
export class FakeDataStore implements DataStore {
  readonly pages = new Map<string, SitemapEntry>();
  readonly findings: Finding[] = [];
  readonly messages: AddMessageInput[] = [];

  private session: Session | null = null;
  private readonly features = new Map<number, Feature>();
  private readonly revisions = new Map<number, Array<{ plan: TestPlan; scenarios: Scenario[] }>>();
  private readonly runsByScenario = new Map<number, TestRun[]>();

  private nextFindingId = 1;
  private nextMessageId = 1;
  private nextFeatureId = 1;
  private nextPlanId = 1;
  private nextScenarioId = 1;
  private nextRunId = 1;

  async registerSession(
    session: Omit<Session, "completedAt"> & { completedAt?: number | null },
  ): Promise<Result<Session, Error>> {
    const stored: Session = { ...session, completedAt: session.completedAt ?? null };
    this.session = stored;
    return Ok(stored);
  }

  async completeSession(status: "completed" | "failed"): Promise<Result<void, Error>> {
    if (this.session) {
      this.session = {
        ...this.session,
        status,
        completedAt: Date.now(),
      };
    }
    return Ok(undefined);
  }

  async getSession(): Promise<Result<Session | null, Error>> {
    return Ok(this.session ? { ...this.session } : null);
  }

  async upsertPage(entry: UpsertPageInput): Promise<Result<void, Error>> {
    const existing = this.pages.get(entry.url);
    const status = pickHigherStatus(existing?.status, entry.status);
    this.pages.set(entry.url, {
      url: entry.url,
      title: entry.title || existing?.title || "",
      links: entry.links.length > 0 ? entry.links : (existing?.links ?? []),
      status,
      discoveredAt: existing?.discoveredAt ?? entry.discoveredAt ?? Date.now(),
      visitedAt: entry.visitedAt ?? existing?.visitedAt ?? null,
    });
    return Ok(undefined);
  }

  async visitPage(url: string, title: string, links: string[]): Promise<Result<void, Error>> {
    return this.upsertPage({ url, title, links, status: "visited", visitedAt: Date.now() });
  }

  async discoverPage(url: string): Promise<Result<void, Error>> {
    if (!this.pages.has(url)) {
      this.pages.set(url, {
        url,
        title: "",
        links: [],
        status: "discovered",
        discoveredAt: Date.now(),
        visitedAt: null,
      });
    }
    return Ok(undefined);
  }

  async getPage(url: string): Promise<Result<SitemapEntry | null, Error>> {
    return Ok(this.pages.get(url) ?? null);
  }

  async getUnvisitedPages(limit = 10): Promise<Result<SitemapEntry[], Error>> {
    return Ok([...this.pages.values()].filter((p) => p.status === "discovered").slice(0, limit));
  }

  async getUntestedPages(limit = 10): Promise<Result<SitemapEntry[], Error>> {
    return Ok([...this.pages.values()].filter((p) => p.status === "visited").slice(0, limit));
  }

  async getAllPages(): Promise<Result<SitemapEntry[], Error>> {
    return Ok([...this.pages.values()]);
  }

  async getSitemapStats(): Promise<Result<SitemapStats, Error>> {
    const all = [...this.pages.values()];
    return Ok({
      total: all.length,
      discovered: all.filter((p) => p.status === "discovered").length,
      visited: all.filter((p) => p.status === "visited").length,
      tested: all.filter((p) => p.status === "tested").length,
    });
  }

  async invalidatePage(url: string): Promise<Result<void, Error>> {
    const existing = this.pages.get(url);
    if (existing) {
      this.pages.set(url, { ...existing, status: "discovered", visitedAt: null });
    }
    return Ok(undefined);
  }

  async removePage(url: string): Promise<Result<void, Error>> {
    this.pages.delete(url);
    return Ok(undefined);
  }

  async addFinding(input: AddFindingInput): Promise<Result<number, Error>> {
    const id = this.nextFindingId++;
    this.findings.push({ id, ...input });
    return Ok(id);
  }

  async getFindings(url?: string): Promise<Result<Finding[], Error>> {
    return Ok(url ? this.findings.filter((f) => f.url === url) : [...this.findings]);
  }

  async getFindingsStats(): Promise<Result<FindingsStats, Error>> {
    const stats = { info: 0, warning: 0, error: 0, critical: 0 } as FindingsStats;
    for (const finding of this.findings) {
      stats[finding.severity] = (stats[finding.severity] ?? 0) + 1;
    }
    return Ok(stats);
  }

  async addMessage(message: AddMessageInput): Promise<Result<number, Error>> {
    const id = this.nextMessageId++;
    this.messages.push(message);
    return Ok(id);
  }

  async createFeature(
    input: CreateFeatureInput,
  ): Promise<Result<{ feature: Feature; activePlan: ActivePlanBundle | null }, Error>> {
    const now = Date.now();
    const feature: Feature = {
      id: this.nextFeatureId++,
      sessionId: this.session?.id ?? "test-session",
      name: input.name,
      description: input.description ?? "",
      urlPatterns: [...input.urlPatterns],
      status: input.status ?? "active",
      discoveredBy: input.discoveredBy ?? "manual",
      discoveredAt: now,
      verifiedAt: null,
    };

    this.features.set(feature.id, feature);
    this.revisions.set(feature.id, []);

    let activePlan: ActivePlanBundle | null = null;
    if (input.initialPlan && input.initialPlan.scenarios.length > 0) {
      activePlan = this.appendPlan(feature.id, 1, input.initialPlan, now);
    }

    return Ok({ feature: cloneFeature(feature), activePlan: cloneActivePlan(activePlan) });
  }

  async listFeatures(opts?: {
    status?: FeatureStatus;
  }): Promise<Result<FeatureWithActivePlan[], Error>> {
    const out: FeatureWithActivePlan[] = [];
    for (const feature of this.features.values()) {
      if (opts?.status && feature.status !== opts.status) continue;
      out.push({
        feature: cloneFeature(feature),
        activePlan: cloneActivePlan(this.getActivePlanBundle(feature.id)),
      });
    }
    return Ok(out);
  }

  async getFeature(id: number): Promise<Result<FeatureDetail | null, Error>> {
    const feature = this.features.get(id);
    if (!feature) return Ok(null);

    const revisions = [...(this.revisions.get(id) ?? [])]
      .sort((a, b) => b.plan.revision - a.plan.revision)
      .map((revision) => ({
        plan: { ...revision.plan },
        scenarios: revision.scenarios.map((scenario) => ({
          ...scenario,
          steps: [...scenario.steps],
        })),
      }));

    return Ok({
      feature: cloneFeature(feature),
      activePlan: cloneActivePlan(this.getActivePlanBundle(id)),
      revisions,
    });
  }

  async updateFeature(id: number, patch: UpdateFeatureInput): Promise<Result<Feature, Error>> {
    const feature = this.features.get(id);
    if (!feature) return Err(new Error(`feature ${id} not found`));

    const updated: Feature = {
      ...feature,
      status: patch.status ?? feature.status,
      description: patch.description ?? feature.description,
      urlPatterns: patch.urlPatterns ? [...patch.urlPatterns] : [...feature.urlPatterns],
      verifiedAt: patch.verifiedAt !== undefined ? patch.verifiedAt : feature.verifiedAt,
    };

    this.features.set(id, updated);
    return Ok(cloneFeature(updated));
  }

  async addTestPlan(
    featureId: number,
    input: CreateTestPlanInput,
  ): Promise<Result<ActivePlanBundle, Error>> {
    if (!this.features.has(featureId)) return Err(new Error(`feature ${featureId} not found`));

    const existing = this.revisions.get(featureId) ?? [];
    for (const revision of existing) {
      if (revision.plan.status === "active") {
        revision.plan.status = "superseded";
      }
    }

    const maxRevision = existing.reduce(
      (max, revision) => Math.max(max, revision.plan.revision),
      0,
    );
    const bundle = this.appendPlan(featureId, maxRevision + 1, input, Date.now());
    return Ok(cloneActivePlan(bundle) as ActivePlanBundle);
  }

  async recordTestRun(
    scenarioId: number,
    input: CreateTestRunInput,
  ): Promise<Result<TestRun, Error>> {
    const scenarioExists = this.findScenarioById(scenarioId) !== null;
    if (!scenarioExists) return Err(new Error(`scenario ${scenarioId} not found`));

    const run: TestRun = {
      id: this.nextRunId++,
      scenarioId,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      result: input.result,
      stepTrace: [...input.stepTrace],
      findingId: input.findingId ?? null,
      diagnostics: input.diagnostics ?? null,
    };

    const runs = this.runsByScenario.get(scenarioId) ?? [];
    runs.push(run);
    this.runsByScenario.set(scenarioId, runs);
    return Ok({ ...run });
  }

  /** Tests do not exercise binary artifact upload — satisfy the interface only. */
  async uploadTestRunArtifact(): Promise<Result<void, Error>> {
    return Ok(undefined);
  }

  async markPlanNeedsRevision(
    planId: number,
    feedback: RevisionFeedback,
  ): Promise<Result<void, Error>> {
    for (const revisions of this.revisions.values()) {
      const target = revisions.find((revision) => revision.plan.id === planId);
      if (!target) continue;
      if (target.plan.status !== "active") {
        return Err(new Error(`plan ${planId} not in active status`));
      }
      target.plan.status = "needs_revision";
      target.plan.revisionFeedback = { ...feedback };
      return Ok(undefined);
    }
    return Err(new Error(`plan ${planId} not found`));
  }


  async listScenarios(opts: {
    runState: "unrun-this-session" | "failed" | "stale";
    since?: number;
  }): Promise<Result<Scenario[], Error>> {
    const rows: Scenario[] = [];

    for (const feature of this.features.values()) {
      const revisions = this.revisions.get(feature.id) ?? [];
      for (const revision of revisions) {
        for (const scenario of revision.scenarios) {
          const latestRun = this.latestRun(scenario.id);
          if (opts.runState === "stale") {
            if (feature.status === "stale") rows.push({ ...scenario, steps: [...scenario.steps] });
            continue;
          }

          if (opts.runState === "failed") {
            if (latestRun && (latestRun.result === "fail" || latestRun.result === "error")) {
              rows.push({ ...scenario, steps: [...scenario.steps] });
            }
            continue;
          }

          if (!latestRun) {
            rows.push({ ...scenario, steps: [...scenario.steps] });
            continue;
          }

          if (typeof opts.since === "number" && latestRun.startedAt < opts.since) {
            rows.push({ ...scenario, steps: [...scenario.steps] });
          }
        }
      }
    }

    rows.sort((a, b) => a.id - b.id);
    return Ok(rows);
  }

  close(): void {
    /* no-op */
  }

  private appendPlan(
    featureId: number,
    revision: number,
    input: CreateTestPlanInput,
    now: number,
  ): ActivePlanBundle {
    const plan: TestPlan = {
      id: this.nextPlanId++,
      featureId,
      revision,
      status: "active",
      verifiedAt: null,
      createdBy: input.createdBy ?? "manual",
      createdAt: now,
      revisionFeedback: null,
    };

    const scenarios: Scenario[] = input.scenarios.map((scenario) => ({
      id: this.nextScenarioId++,
      testPlanId: plan.id,
      name: scenario.name,
      entryUrl: scenario.entryUrl,
      steps: [...scenario.steps],
      expectedOutcome: scenario.expectedOutcome,
      createdAt: now,
    }));

    const revisions = this.revisions.get(featureId) ?? [];
    revisions.push({ plan, scenarios });
    this.revisions.set(featureId, revisions);

    return {
      plan: { ...plan },
      scenarios: scenarios.map((scenario) => ({ ...scenario, steps: [...scenario.steps] })),
    };
  }

  private getActivePlanBundle(featureId: number): ActivePlanBundle | null {
    const revisions = this.revisions.get(featureId) ?? [];
    const active = revisions.find((revision) => revision.plan.status === "active");
    if (!active) return null;
    return {
      plan: { ...active.plan },
      scenarios: active.scenarios.map((scenario) => ({ ...scenario, steps: [...scenario.steps] })),
    };
  }

  private latestRun(scenarioId: number): TestRun | null {
    const runs = this.runsByScenario.get(scenarioId);
    if (!runs || runs.length === 0) return null;
    return [...runs].sort((a, b) => b.startedAt - a.startedAt)[0];
  }

  private findScenarioById(scenarioId: number): Scenario | null {
    for (const revisionRows of this.revisions.values()) {
      for (const revision of revisionRows) {
        const found = revision.scenarios.find((scenario) => scenario.id === scenarioId);
        if (found) return found;
      }
    }
    return null;
  }
}

function cloneFeature(feature: Feature): Feature {
  return { ...feature, urlPatterns: [...feature.urlPatterns] };
}

function cloneActivePlan(activePlan: ActivePlanBundle | null): ActivePlanBundle | null {
  if (!activePlan) return null;
  return {
    plan: { ...activePlan.plan },
    scenarios: activePlan.scenarios.map((scenario) => ({
      ...scenario,
      steps: [...scenario.steps],
    })),
  };
}

function pickHigherStatus(
  prev: SitemapEntry["status"] | undefined,
  next: SitemapEntry["status"],
): SitemapEntry["status"] {
  const rank: Record<SitemapEntry["status"], number> = { discovered: 0, visited: 1, tested: 2 };
  if (!prev) return next;
  return rank[next] >= rank[prev] ? next : prev;
}

/**
 * Convenience matcher for asserting tool-call sequences captured during a Pi
 * session. Pair with `session.subscribe` in tests.
 */
export type RecordedToolCall = { name: string; args: unknown };

export function recordToolCalls(session: { subscribe: (l: (e: unknown) => void) => () => void }): {
  calls: RecordedToolCall[];
  unsubscribe: () => void;
} {
  const calls: RecordedToolCall[] = [];
  const unsubscribe = session.subscribe((event) => {
    const e = event as { type?: string; toolName?: string; args?: unknown };
    if (e.type === "tool_execution_start" && typeof e.toolName === "string") {
      calls.push({ name: e.toolName, args: e.args });
    }
  });
  return { calls, unsubscribe };
}

/** Re-export so tests don't need to import vitest separately for spies. */
export const spy = vi.fn;
