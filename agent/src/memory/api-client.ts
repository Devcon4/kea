import type { Session } from "@kea/shared";
import { tryCatch } from "@kea/shared";
import type { Result } from "../result.js";
import type {
  DataStore,
  SitemapEntry,
  SitemapStats,
  FindingsStats,
  UpsertPageInput,
  AddFindingInput,
  AddMessageInput,
  Finding,
  Feature,
  FeatureStatus,
  FeatureWithActivePlan,
  FeatureDetail,
  RevisionFeedback,
  UpdateFeatureInput,
  CreateFeatureInput,
  CreateTestPlanInput,
  ActivePlanBundle,
  CreateTestRunInput,
  Scenario,
  TestRun,
  UploadTestRunArtifactInput,
} from "./data-store.js";
import { createLogger } from "../logger.js";

const log = createLogger("api-client");

export type ApiClientOptions = {
  baseUrl: string;
  sessionId: string;
};

export class ApiClient implements DataStore {
  private baseUrl: string;
  private sessionId: string;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.sessionId = opts.sessionId;
  }

  private sessionUrl(path: string): string {
    return `${this.baseUrl}/api/sessions/${this.sessionId}${path}`;
  }

  private apiUrl(path: string): string {
    return `${this.baseUrl}/api${path}`;
  }

  private async request(method: string, url: string, body?: unknown): Promise<Response> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    return this.fetchAuthed(url, init);
  }

  /**
   * Single egress point for HTTP calls. Always attaches `X-Kea-Session` so
   * the API can refuse cross-session reads/writes (a coordinator that
   * hallucinates another session's feature/plan/scenario id will be
   * rejected at the server). Direct `fetch` calls **MUST** be funneled
   * through this helper — the guard is useless if any call site bypasses
   * it.
   */
  private async fetchAuthed(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers ?? {});
    headers.set("X-Kea-Session", this.sessionId);
    return fetch(url, { ...init, headers });
  }

  private async post(path: string, body: unknown): Promise<Response> {
    return this.request("POST", this.sessionUrl(path), body);
  }

  private async put(path: string, body: unknown): Promise<Response> {
    return this.request("PUT", this.sessionUrl(path), body);
  }

  private assertOk(res: Response, action: string): void {
    if (!res.ok) throw new Error(`${action} failed: ${res.status}`);
  }

  // -- Session lifecycle --

  async registerSession(
    session: Omit<Session, "completedAt"> & { completedAt?: number | null },
  ): Promise<Result<Session, Error>> {
    return tryCatch(async () => {
      const res = await this.request("POST", `${this.baseUrl}/api/sessions`, session);
      this.assertOk(res, "register session");
      return (await res.json()) as Session;
    });
  }

  async getSession(): Promise<Result<Session | null, Error>> {
    return tryCatch(async () => {
      const res = await this.fetchAuthed(this.sessionUrl(""));
      if (res.status === 404) return null;
      this.assertOk(res, "get session");
      return (await res.json()) as Session;
    });
  }

  async completeSession(status: "completed" | "failed"): Promise<Result<void, Error>> {
    return tryCatch(async () => {
      const res = await this.request("PATCH", `${this.baseUrl}/api/sessions/${this.sessionId}`, {
        status,
        completedAt: Date.now(),
      });
      this.assertOk(res, "complete session");
    });
  }

  // -- Sitemap --

  async upsertPage(entry: UpsertPageInput): Promise<Result<void, Error>> {
    return tryCatch(async () => {
      const res = await this.put("/sitemap", {
        url: entry.url,
        title: entry.title,
        links: entry.links,
        status: entry.status,
        discoveredAt: entry.discoveredAt,
        visitedAt: entry.visitedAt ?? null,
      });
      this.assertOk(res, "upsertPage");
    });
  }

  async visitPage(url: string, title: string, links: string[]): Promise<Result<void, Error>> {
    return tryCatch(async () => {
      const res = await this.post("/sitemap/visit", {
        url,
        title,
        links,
      });
      this.assertOk(res, "visitPage");
    });
  }

  async discoverPage(url: string): Promise<Result<void, Error>> {
    return tryCatch(async () => {
      const res = await this.post("/sitemap/discover", {
        url,
      });
      this.assertOk(res, "discoverPage");
    });
  }

  async getPage(url: string): Promise<Result<SitemapEntry | null, Error>> {
    return tryCatch(async () => {
      const res = await this.fetchAuthed(`${this.sessionUrl("/sitemap")}?status=&limit=&url=${encodeURIComponent(url)}`,);
      this.assertOk(res, "getPage");
      const pages = (await res.json()) as SitemapEntry[];
      return pages.find((p) => p.url === url) ?? null;
    });
  }

  async getUnvisitedPages(limit = 10): Promise<Result<SitemapEntry[], Error>> {
    return tryCatch(async () => {
      const res = await this.fetchAuthed(`${this.sessionUrl("/sitemap")}?status=discovered&limit=${limit}`);
      this.assertOk(res, "getUnvisitedPages");
      return (await res.json()) as SitemapEntry[];
    });
  }

  async getUntestedPages(limit = 10): Promise<Result<SitemapEntry[], Error>> {
    return tryCatch(async () => {
      const res = await this.fetchAuthed(`${this.sessionUrl("/sitemap")}?status=visited&limit=${limit}`);
      this.assertOk(res, "getUntestedPages");
      return (await res.json()) as SitemapEntry[];
    });
  }

  async getAllPages(): Promise<Result<SitemapEntry[], Error>> {
    return tryCatch(async () => {
      const res = await this.fetchAuthed(this.sessionUrl("/sitemap"));
      this.assertOk(res, "getAllPages");
      return (await res.json()) as SitemapEntry[];
    });
  }

  async getSitemapStats(): Promise<Result<SitemapStats, Error>> {
    return tryCatch(async () => {
      const res = await this.fetchAuthed(this.sessionUrl("/stats"));
      this.assertOk(res, "getSitemapStats");
      const body = (await res.json()) as {
        sitemap: SitemapStats;
        findings: FindingsStats;
      };
      return body.sitemap;
    });
  }

  async invalidatePage(url: string): Promise<Result<void, Error>> {
    return tryCatch(async () => {
      const res = await this.put("/sitemap", {
        url,
        title: "",
        links: [],
        status: "discovered",
        visitedAt: null,
      });
      this.assertOk(res, "invalidatePage");
    });
  }

  async removePage(url: string): Promise<Result<void, Error>> {
    return tryCatch(async () => {
      const res = await this.fetchAuthed(`${this.sessionUrl("/sitemap")}?url=${encodeURIComponent(url)}`, {
        method: "DELETE",
      });
      this.assertOk(res, "removePage");
    });
  }

  // -- Findings --

  async addFinding(finding: AddFindingInput): Promise<Result<number, Error>> {
    return tryCatch(async () => {
      const res = await this.post("/findings", finding);
      this.assertOk(res, "addFinding");
      const body = (await res.json()) as Finding;
      return body.id;
    });
  }

  async getFindings(url?: string): Promise<Result<Finding[], Error>> {
    return tryCatch(async () => {
      const query = url ? `?url=${encodeURIComponent(url)}` : "";
      const res = await this.fetchAuthed(`${this.sessionUrl("/findings")}${query}`);
      this.assertOk(res, "getFindings");
      return (await res.json()) as Finding[];
    });
  }

  async getFindingsStats(): Promise<Result<FindingsStats, Error>> {
    return tryCatch(async () => {
      const res = await this.fetchAuthed(this.sessionUrl("/stats"));
      this.assertOk(res, "getFindingsStats");
      const body = (await res.json()) as {
        sitemap: SitemapStats;
        findings: FindingsStats;
      };
      return body.findings;
    });
  }

  // -- Messages --

  async addMessage(message: AddMessageInput): Promise<Result<number, Error>> {
    return tryCatch(async () => {
      const res = await this.post("/messages", message);
      this.assertOk(res, "addMessage");
      const body = (await res.json()) as { id: number };
      return body.id;
    });
  }

  // -- Features / test plans / scenarios --

  async createFeature(
    input: CreateFeatureInput,
  ): Promise<Result<{ feature: Feature; activePlan: ActivePlanBundle | null }, Error>> {
    return tryCatch(async () => {
      const res = await this.request("POST", this.sessionUrl("/features"), input);
      this.assertOk(res, "createFeature");
      return (await res.json()) as { feature: Feature; activePlan: ActivePlanBundle | null };
    });
  }

  async listFeatures(opts?: {
    status?: FeatureStatus;
  }): Promise<Result<FeatureWithActivePlan[], Error>> {
    return tryCatch(async () => {
      const query = new URLSearchParams();
      if (opts?.status) query.set("status", opts.status);
      const qs = query.toString();
      const res = await this.fetchAuthed(`${this.sessionUrl("/features")}${qs ? `?${qs}` : ""}`);
      this.assertOk(res, "listFeatures");
      return (await res.json()) as FeatureWithActivePlan[];
    });
  }

  async getFeature(id: number): Promise<Result<FeatureDetail | null, Error>> {
    return tryCatch(async () => {
      const res = await this.fetchAuthed(this.apiUrl(`/features/${id}`));
      if (res.status === 404) return null;
      this.assertOk(res, "getFeature");
      return (await res.json()) as FeatureDetail;
    });
  }

  async updateFeature(id: number, patch: UpdateFeatureInput): Promise<Result<Feature, Error>> {
    return tryCatch(async () => {
      const res = await this.request("PATCH", this.apiUrl(`/features/${id}`), patch);
      this.assertOk(res, "updateFeature");
      return (await res.json()) as Feature;
    });
  }

  async addTestPlan(
    featureId: number,
    input: CreateTestPlanInput,
  ): Promise<Result<ActivePlanBundle, Error>> {
    return tryCatch(async () => {
      const res = await this.request(
        "POST",
        this.apiUrl(`/features/${featureId}/test-plans`),
        input,
      );
      this.assertOk(res, "addTestPlan");
      return (await res.json()) as ActivePlanBundle;
    });
  }

  async markPlanNeedsRevision(
    planId: number,
    feedback: RevisionFeedback,
  ): Promise<Result<void, Error>> {
    return tryCatch(async () => {
      const res = await this.request(
        "PATCH",
        this.apiUrl(`/test-plans/${planId}/needs-revision`),
        { feedback },
      );
      this.assertOk(res, "markPlanNeedsRevision");
    });
  }

  async recordTestRun(
    scenarioId: number,
    input: CreateTestRunInput,
  ): Promise<Result<TestRun, Error>> {
    return tryCatch(async () => {
      const res = await this.request("POST", this.apiUrl(`/scenarios/${scenarioId}/runs`), input);
      this.assertOk(res, "recordTestRun");
      return (await res.json()) as TestRun;
    });
  }

  async uploadTestRunArtifact(
    input: UploadTestRunArtifactInput,
  ): Promise<Result<void, Error>> {
    return tryCatch(async () => {
      const res = await this.fetchAuthed(this.apiUrl(`/test-runs/${input.testRunId}/artifacts/${input.kind}`),
      {
        method: "PUT",
        headers: { "Content-Type": input.contentType },
        body: input.bytes,
      },);
      this.assertOk(res, "uploadTestRunArtifact");
    });
  }

  async listScenarios(opts: {
    runState: "unrun-this-session" | "failed" | "stale";
    since?: number;
  }): Promise<Result<Scenario[], Error>> {
    return tryCatch(async () => {
      const query = new URLSearchParams({ runState: opts.runState });
      if (typeof opts.since === "number") query.set("since", String(opts.since));
      const res = await this.fetchAuthed(`${this.sessionUrl("/scenarios")}?${query.toString()}`);
      this.assertOk(res, "listScenarios");
      return (await res.json()) as Scenario[];
    });
  }

  // -- No-op close (no local DB to close) --
  close(): void {
    log.info("api client closed (no-op)");
  }
}
