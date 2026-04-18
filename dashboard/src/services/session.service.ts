import { BehaviorSubject, map, timer, switchMap, catchError, of } from "rxjs";

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

export class SessionService {
  private readonly _sessions$ = new BehaviorSubject<SessionWithStats[]>([]);
  private apiBaseUrl: string;

  constructor(apiBaseUrl = "/api") {
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, "");
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

  /** Start polling sessions from the API at a given interval (ms). Returns a teardown. */
  startPolling(intervalMs = 5000): () => void {
    const sub = timer(0, intervalMs)
      .pipe(
        switchMap(() => this.fetchSessions()),
        catchError(() => of([])),
      )
      .subscribe((sessions) => this._sessions$.next(sessions));

    return () => sub.unsubscribe();
  }

  private async fetchSessions(): Promise<SessionWithStats[]> {
    const res = await fetch(`${this.apiBaseUrl}/sessions`);
    if (!res.ok) return [];

    const sessions: Session[] = await res.json();

    // Fetch stats for each session in parallel
    const withStats = await Promise.all(
      sessions.map(async (session) => {
        const statsRes = await fetch(
          `${this.apiBaseUrl}/sessions/${session.id}/stats`,
        );
        const stats = statsRes.ok
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
    const updated = current.map((s) =>
      s.id === id ? { ...s, ...updates } : s,
    );
    this._sessions$.next(updated);
  }

  removeSession(id: string): void {
    const current = this._sessions$.value.filter((s) => s.id !== id);
    this._sessions$.next(current);
  }

  /** Fetch a single session with full stats. */
  async fetchSessionDetail(id: string): Promise<SessionDetail | null> {
    const [sessionRes, statsRes] = await Promise.all([
      fetch(`${this.apiBaseUrl}/sessions/${id}`),
      fetch(`${this.apiBaseUrl}/sessions/${id}/stats`),
    ]);
    if (!sessionRes.ok) return null;

    const session: Session = await sessionRes.json();
    const stats = statsRes.ok
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

  /** Fetch findings for a session, optionally filtered by URL. */
  async fetchFindings(sessionId: string, url?: string): Promise<Finding[]> {
    const query = url ? `?url=${encodeURIComponent(url)}` : "";
    const res = await fetch(`${this.apiBaseUrl}/sessions/${sessionId}/findings${query}`);
    if (!res.ok) return [];
    return res.json();
  }

  /** Fetch sitemap entries for a session, optionally filtered by status. */
  async fetchSitemap(sessionId: string, status?: string): Promise<SitemapEntry[]> {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const res = await fetch(`${this.apiBaseUrl}/sessions/${sessionId}/sitemap${query}`);
    if (!res.ok) return [];
    return res.json();
  }

  /** Fetch agent chat messages for a session. */
  async fetchMessages(sessionId: string): Promise<ChatMessage[]> {
    const res = await fetch(`${this.apiBaseUrl}/sessions/${sessionId}/messages`);
    if (!res.ok) return [];
    return res.json();
  }
}
