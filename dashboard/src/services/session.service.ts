import { BehaviorSubject, map } from "rxjs";

export type SessionStatus = "running" | "completed" | "failed";
export type PageStatus = "discovered" | "visited" | "tested";
export type Severity = "info" | "warning" | "error" | "critical";

export type Session = {
  id: string;
  targetUrl: string;
  status: SessionStatus;
  maxPages: number;
  config: Record<string, unknown>;
  startedAt: number;
  completedAt: number | null;
};

export type SessionWithStats = Session & {
  pagesVisited: number;
  pagesTotal: number;
  findingsCount: number;
};

export type SitemapEntry = {
  url: string;
  title: string;
  links: string[];
  status: PageStatus;
  discoveredAt: number;
  visitedAt: number | null;
};

export type SitemapStats = {
  total: number;
  discovered: number;
  visited: number;
  tested: number;
};

export type Finding = {
  id: number;
  sessionId: string;
  url: string;
  agentId: string;
  action: string;
  result: string;
  severity: Severity;
  timestamp: number;
  scenarioId: number | null;
};

export type FindingsStats = Record<Severity, number>;

export type ChatMessage = {
  id: number;
  sessionId: string;
  agentId: string;
  content: string;
  thinking: string | null;
  timestamp: number;
};

export type SessionDetail = SessionWithStats & {
  sitemapStats: SitemapStats;
  findingsStats: FindingsStats;
};

// -- Features / Test Plans / Scenarios / Runs (FDD-0010) --

export type FeatureStatus = "active" | "stale" | "retired";
export type FeatureDiscoveredBy = "planner" | "manual" | "crd";

export type Feature = {
  id: number;
  sessionId: string;
  name: string;
  description: string;
  urlPatterns: string[];
  status: FeatureStatus;
  discoveredBy: FeatureDiscoveredBy;
  discoveredAt: number;
  verifiedAt: number | null;
};

export type TestPlanStatus = "active" | "superseded" | "stale";
export type TestPlanCreatedBy = "planner" | "manual" | "crd";

export type TestPlan = {
  id: number;
  featureId: number;
  revision: number;
  status: TestPlanStatus;
  verifiedAt: number | null;
  createdBy: TestPlanCreatedBy;
  createdAt: number;
};

export type ExpectClause =
  | { kind: "equal"; value: unknown }
  | { kind: "regex"; pattern: string; flags?: string }
  | { kind: "semantic"; question: string };

export type ScenarioStep =
  | { kind: "navigate"; url: string }
  | { kind: "act"; instruction: string; verifyWith?: string }
  | { kind: "observe"; question: string; expect: ExpectClause }
  | { kind: "extract"; schema: Record<string, unknown>; bind?: string; expect?: ExpectClause };

export type Scenario = {
  id: number;
  testPlanId: number;
  name: string;
  entryUrl: string;
  steps: ScenarioStep[];
  expectedOutcome: string;
  createdAt: number;
};

export type TestRunResult = "pass" | "fail" | "skipped" | "error";

export type StepTraceEntry = {
  index: number;
  kind: "navigate" | "act" | "observe" | "extract";
  args: Record<string, unknown>;
  result: "pass" | "fail" | "skipped" | "error";
  evidence: string;
  latencyMs: number;
};

export type ConsoleMessage = {
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
  timestamp: number;
};

export type PageError = {
  message: string;
  stack: string | null;
  timestamp: number;
};

export type NetworkFailure = {
  url: string;
  method: string;
  status: number | null;
  statusText: string | null;
  errorText: string | null;
  timestamp: number;
};

export type LlmFailure = {
  url: string;
  method: string;
  status: number;
  requestBody: string;
  requestBodyTruncated: boolean;
  responseBody: string;
  responseBodyTruncated: boolean;
  elapsedMs: number;
  timestamp: number;
};

export type RunDiagnostics = {
  failingStepIndex: number | null;
  pageUrl: string;
  pageTitle: string;
  domSnippet: string;
  domTruncated: boolean;
  consoleMessages: ConsoleMessage[];
  pageErrors: PageError[];
  networkFailures: NetworkFailure[];
  llmFailures: LlmFailure[];
  expected?: unknown;
  observed?: unknown;
  capturedAt: number;
};

export type TestRun = {
  id: number;
  scenarioId: number;
  startedAt: number;
  completedAt: number | null;
  result: TestRunResult;
  stepTrace: StepTraceEntry[];
  findingId: number | null;
  diagnostics: RunDiagnostics | null;
};

export type ScenarioWithLatestRun = Scenario & { latestRun: TestRun | null };

export type FeatureWithActivePlan = {
  feature: Feature;
  activePlan: { plan: TestPlan; scenarios: ScenarioWithLatestRun[] } | null;
};

/**
 * Run row for the session-wide Runs tab. The API joins scenario + feature
 * context so the dashboard can render "Auth · login flow · fail" without
 * a follow-up lookup per row.
 */
export type SessionRunRow = TestRun & {
  scenarioName: string;
  scenarioEntryUrl: string;
  featureId: number;
  featureName: string;
};

export class SessionService {
  private readonly _sessions$ = new BehaviorSubject<SessionWithStats[]>([]);
  private apiBaseUrl: string;

  constructor(apiBaseUrl = "/api") {
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, "");
  }

  /**
   * Wraps fetch so that network-layer errors (offline, ERR_NETWORK_CHANGED on
   * Wi-Fi roam, DNS hiccups) are not propagated as unhandled rejections.
   * Returns null on network failure or non-2xx response; callers fall back to
   * empty data. The next SSE refresh event (or the next user-initiated
   * action) re-issues the fetch — there is no polling backstop.
   */
  private async safeFetch(input: string, init?: RequestInit): Promise<Response | null> {
    try {
      const res = await fetch(input, init);
      return res.ok ? res : null;
    } catch (err) {
      if (typeof console !== "undefined") {
        console.debug("[session-service] fetch failed; awaiting next refresh", input, err);
      }
      return null;
    }
  }

  readonly sessions$ = this._sessions$.asObservable();

  readonly activeCount$ = this._sessions$.pipe(
    map((sessions) => sessions.filter((s) => s.status === "running").length),
  );

  readonly totalFindings$ = this._sessions$.pipe(
    map((sessions) => sessions.reduce((sum, s) => sum + s.findingsCount, 0)),
  );

  get sessions(): SessionWithStats[] {
    return this._sessions$.value;
  }

  /**
   * Subscribe to the session-list SSE channel. Refetches on every event —
   * the channel emits both list-shaped events (`session-list`) and per-session
   * events that affect list-displayed counters (sitemap, findings, session
   * status). On open and on reconnect the dashboard receives a fresh fetch
   * so transient connection drops self-heal without a polling backstop.
   *
   * Returns a teardown that closes the EventSource. The browser handles
   * reconnection automatically; we never poll.
   */
  subscribeSessionList(): () => void {
    // Initial fetch so the list isn't empty before the first event arrives.
    void this.fetchSessions().then((rows) => this._sessions$.next(rows));

    const url = `${this.apiBaseUrl}/sessions/stream`;
    const es = new EventSource(url);
    const refetch = (): void => {
      void this.fetchSessions().then((rows) => this._sessions$.next(rows));
    };
    es.addEventListener("refresh", refetch);
    // Browsers fire 'open' on first connect AND on reconnect after error;
    // refetch on each so the gap between disconnect and reconnect is bridged.
    es.addEventListener("open", refetch);

    return () => {
      es.removeEventListener("refresh", refetch);
      es.removeEventListener("open", refetch);
      es.close();
    };
  }

  /**
   * Subscribe to per-session events. Handlers fire as events arrive on the
   * single SSE channel; callers dispatch to whichever data they care about
   * (chat for `message`, targeted refetch for `refresh`). Returns a teardown.
   *
   * Refresh kinds: "session" | "sitemap" | "findings" | "features".
   */
  subscribeSession(
    sessionId: string,
    handlers: {
      onMessage?: (message: ChatMessage) => void;
      onRefresh?: (kind: "session" | "sitemap" | "findings" | "features") => void;
    },
  ): () => void {
    const url = `${this.apiBaseUrl}/sessions/${sessionId}/stream`;
    const es = new EventSource(url);

    const onMessage = (e: MessageEvent): void => {
      if (!handlers.onMessage) return;
      try {
        handlers.onMessage(JSON.parse(e.data) as ChatMessage);
      } catch {
        /* malformed; ignore */
      }
    };

    const onRefresh = (e: MessageEvent): void => {
      if (!handlers.onRefresh) return;
      try {
        const payload = JSON.parse(e.data) as { kind?: string };
        if (
          payload.kind === "session" ||
          payload.kind === "sitemap" ||
          payload.kind === "findings" ||
          payload.kind === "features"
        ) {
          handlers.onRefresh(payload.kind);
        }
      } catch {
        /* malformed; ignore */
      }
    };

    es.addEventListener("message", onMessage);
    es.addEventListener("refresh", onRefresh);

    return () => {
      es.removeEventListener("message", onMessage);
      es.removeEventListener("refresh", onRefresh);
      es.close();
    };
  }

  private async fetchSessions(): Promise<SessionWithStats[]> {
    const res = await this.safeFetch(`${this.apiBaseUrl}/sessions`);
    if (!res) return [];

    const sessions: Session[] = await res.json();

    // Fetch stats for each session in parallel
    const withStats = await Promise.all(
      sessions.map(async (session) => {
        const statsRes = await this.safeFetch(`${this.apiBaseUrl}/sessions/${session.id}/stats`);
        const stats = statsRes
          ? await statsRes.json()
          : { sitemap: { total: 0, visited: 0 }, findings: {} };

        return {
          ...session,
          pagesVisited: stats.sitemap?.visited ?? 0,
          pagesTotal: stats.sitemap?.total ?? 0,
          findingsCount: Object.values(stats.findings ?? {}).reduce(
            (sum: number, n) => sum + (n as number),
            0,
          ),
        };
      }),
    );

    return withStats;
  }

  setSessions(sessions: SessionWithStats[]): void {
    this._sessions$.next(sessions);
  }

  addSession(session: SessionWithStats): void {
    this._sessions$.next([...this._sessions$.value, session]);
  }

  updateSession(id: string, updates: Partial<SessionWithStats>): void {
    const current = this._sessions$.value;
    const updated = current.map((s) => (s.id === id ? { ...s, ...updates } : s));
    this._sessions$.next(updated);
  }

  removeSession(id: string): void {
    const current = this._sessions$.value.filter((s) => s.id !== id);
    this._sessions$.next(current);
  }

  /** Fetch a single session with full stats. */
  async fetchSessionDetail(id: string): Promise<SessionDetail | null> {
    const [sessionRes, statsRes] = await Promise.all([
      this.safeFetch(`${this.apiBaseUrl}/sessions/${id}`),
      this.safeFetch(`${this.apiBaseUrl}/sessions/${id}/stats`),
    ]);
    if (!sessionRes) return null;

    const session: Session = await sessionRes.json();
    const stats = statsRes
      ? await statsRes.json()
      : { sitemap: { total: 0, discovered: 0, visited: 0, tested: 0 }, findings: {} };

    return {
      ...session,
      pagesVisited: stats.sitemap?.visited ?? 0,
      pagesTotal: stats.sitemap?.total ?? 0,
      findingsCount: Object.values(stats.findings ?? {}).reduce(
        (sum: number, n) => sum + (n as number),
        0,
      ),
      sitemapStats: stats.sitemap ?? { total: 0, discovered: 0, visited: 0, tested: 0 },
      findingsStats: stats.findings ?? {},
    };
  }

  /** Fetch findings for a session, optionally filtered by URL or scenario. */
  async fetchFindings(
    sessionId: string,
    opts?: { url?: string; scenarioId?: number },
  ): Promise<Finding[]> {
    const params = new URLSearchParams();
    if (opts?.url) params.set("url", opts.url);
    if (opts?.scenarioId !== undefined) params.set("scenarioId", String(opts.scenarioId));
    const query = params.toString() ? `?${params.toString()}` : "";
    const res = await this.safeFetch(`${this.apiBaseUrl}/sessions/${sessionId}/findings${query}`);
    if (!res) return [];
    return res.json();
  }

  /** Fetch sitemap entries for a session, optionally filtered by status. */
  async fetchSitemap(sessionId: string, status?: string): Promise<SitemapEntry[]> {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const res = await this.safeFetch(`${this.apiBaseUrl}/sessions/${sessionId}/sitemap${query}`);
    if (!res) return [];
    return res.json();
  }

  /** Fetch agent chat messages for a session. */
  async fetchMessages(sessionId: string): Promise<ChatMessage[]> {
    const res = await this.safeFetch(`${this.apiBaseUrl}/sessions/${sessionId}/messages`);
    if (!res) return [];
    return res.json();
  }

  /**
   * Fetch features for a session (FDD-0010), each with its currently-active
   * test plan and scenarios. Returns [] on error to keep callers simple;
   * the next `features` refresh event re-issues the fetch.
   */
  async fetchFeatures(sessionId: string, status?: FeatureStatus): Promise<FeatureWithActivePlan[]> {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const res = await this.safeFetch(`${this.apiBaseUrl}/sessions/${sessionId}/features${query}`);
    if (!res) return [];
    return res.json();
  }

  /** Fetch the run history for a single scenario, newest first. */
  async fetchScenarioRuns(scenarioId: number): Promise<TestRun[]> {
    const res = await this.safeFetch(`${this.apiBaseUrl}/scenarios/${scenarioId}/runs`);
    if (!res) return [];
    return res.json();
  }

  /** Fetch every run in the session, newest first, with scenario+feature context. */
  async fetchSessionRuns(sessionId: string): Promise<SessionRunRow[]> {
    const res = await this.safeFetch(`${this.apiBaseUrl}/sessions/${sessionId}/runs`);
    if (!res) return [];
    return res.json();
  }
}
