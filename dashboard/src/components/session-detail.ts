import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { SignalWatcher } from "@lit-labs/signals";
import { consume } from "@lit/context";
import { sessionServiceContext } from "../contexts.js";
import type {
  SessionService,
  SessionDetail,
  Finding,
  SitemapEntry,
  ChatMessage,
  Severity,
  FeatureWithActivePlan,
  SessionRunRow,
} from "../services/session.service.js";
import { timeAgo, formatDuration, formatTimestamp, truncateUrl } from "../utils.js";
import "./findings-table.js";
import "./features-tab.js";
import "./plans-tab.js";
import "./runs-tab.js";
import "./sitemap-table.js";
import "./chat-thread.js";

type Tab = "findings" | "features" | "plans" | "runs" | "sitemap" | "chat";
const VALID_TABS = new Set<Tab>(["findings", "features", "plans", "runs", "sitemap", "chat"]);
const DEFAULT_TAB: Tab = "findings";

function normalizeTab(raw: string | undefined): Tab {
  if (raw && (VALID_TABS as Set<string>).has(raw)) return raw as Tab;
  return DEFAULT_TAB;
}

@customElement("kea-session-detail")
class KeaSessionDetail extends SignalWatcher(LitElement) {
  @consume({ context: sessionServiceContext, subscribe: true })
  sessionService!: SessionService;

  @property() sessionId = "";
  @property() tab: string | undefined;

  @state() private session: SessionDetail | null = null;
  @state() private findings: Finding[] = [];
  @state() private features: FeatureWithActivePlan[] = [];
  @state() private runs: SessionRunRow[] = [];
  @state() private sitemap: SitemapEntry[] = [];
  @state() private chatMessages: ChatMessage[] = [];
  @state() private loading = true;

  private streamUnsub: (() => void) | null = null;


  private get activeTab(): Tab {
    return normalizeTab(this.tab);
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.loadData();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.streamUnsub?.();
    this.streamUnsub = null;
  }

  updated(changed: Map<string, unknown>): void {
    if (changed.has("sessionId") && this.sessionId) {
      this.streamUnsub?.();
      this.streamUnsub = null;
      this.loadData();
    }
  }

  private async loadData(): Promise<void> {
    if (!this.sessionId || !this.sessionService) return;
    this.loading = true;

    const [session, findings, sitemap, chatMessages, features, runs] = await Promise.all([
      this.sessionService.fetchSessionDetail(this.sessionId),
      this.sessionService.fetchFindings(this.sessionId),
      this.sessionService.fetchSitemap(this.sessionId),
      this.sessionService.fetchMessages(this.sessionId),
      this.sessionService.fetchFeatures(this.sessionId),
      this.sessionService.fetchSessionRuns(this.sessionId),
    ]);

    this.session = session;
    this.findings = findings;
    this.sitemap = sitemap;
    this.chatMessages = chatMessages;
    this.features = features;
    this.runs = runs;
    this.loading = false;

    this.startMessageStream();
  }

  private startMessageStream(): void {
    this.streamUnsub?.();
    this.streamUnsub = this.sessionService.subscribeSession(this.sessionId, {
      onMessage: (msg) => {
        // Dedupe by id — chat is append-only, but if a refetch and a push
        // arrive close together both could carry the same id.
        if (this.chatMessages.some((m) => m.id === msg.id)) return;
        this.chatMessages = [...this.chatMessages, msg];
      },
      onRefresh: (kind) => {
        // Targeted refetch by kind. The service does the network; we just
        // swap state. Failures inside fetch* return [] / null so the UI
        // never crashes on a transient API hiccup.
        if (kind === "session") {
          void this.sessionService
            .fetchSessionDetail(this.sessionId)
            .then((session) => {
              if (session) this.session = session;
            });
          return;
        }
        if (kind === "sitemap") {
          void Promise.all([
            this.sessionService.fetchSitemap(this.sessionId),
            this.sessionService.fetchSessionDetail(this.sessionId),
          ]).then(([sitemap, session]) => {
            this.sitemap = sitemap;
            if (session) this.session = session;
          });
          return;
        }
        if (kind === "findings") {
          void Promise.all([
            this.sessionService.fetchFindings(this.sessionId),
            this.sessionService.fetchSessionDetail(this.sessionId),
          ]).then(([findings, session]) => {
            this.findings = findings;
            if (session) this.session = session;
          });
          return;
        }
        if (kind === "features") {
          void Promise.all([
            this.sessionService.fetchFeatures(this.sessionId),
            this.sessionService.fetchSessionRuns(this.sessionId),
          ]).then(([features, runs]) => {
            this.features = features;
            this.runs = runs;
          });
          return;
        }
      },
    });
  }

  static styles = css`
    :host {
      display: block;
    }

    /* ── Back link ─────────────────────────────────── */
    .back {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      font-size: var(--text-sm);
      color: var(--color-text-muted);
      margin-bottom: var(--space-lg);
      transition: color var(--duration-fast);
    }
    .back:hover {
      color: var(--color-primary);
      text-decoration: none;
    }

    /* ── Session header ────────────────────────────── */
    .session-header {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg);
      padding: var(--space-xl);
      margin-bottom: var(--space-xl);
    }

    .session-title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-md);
      margin-bottom: var(--space-sm);
      flex-wrap: wrap;
    }

    .session-url {
      font-family: var(--font-mono);
      font-size: var(--text-lg);
      font-weight: var(--font-weight-semibold);
      color: var(--color-text);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .badge {
      font-size: var(--text-xs);
      font-weight: var(--font-weight-semibold);
      padding: var(--space-xs) var(--space-sm);
      border-radius: var(--radius-full);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      flex-shrink: 0;
    }
    .badge-running {
      background: var(--color-success-muted);
      color: var(--color-success);
    }
    .badge-completed {
      background: var(--color-primary-muted);
      color: var(--color-primary);
    }
    .badge-failed {
      background: var(--color-error-muted);
      color: var(--color-error);
    }

    .session-id {
      font-size: var(--text-xs);
      color: var(--color-text-faint);
      font-family: var(--font-mono);
      margin-bottom: var(--space-md);
    }

    .meta-row {
      display: flex;
      gap: var(--space-xl);
      font-size: var(--text-sm);
      color: var(--color-text-muted);
      flex-wrap: wrap;
    }

    .meta-label {
      color: var(--color-text-faint);
      margin-right: var(--space-xs);
    }

    /* ── Stats cards ────────────────────────────────── */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: var(--space-md);
      margin-bottom: var(--space-xl);
    }

    .stat-card {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      padding: var(--space-md) var(--space-lg);
      text-align: center;
    }

    .stat-number {
      font-size: var(--text-2xl);
      font-weight: var(--font-weight-bold);
      line-height: var(--leading-tight);
    }

    .stat-label {
      font-size: var(--text-xs);
      color: var(--color-text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .stat-info {
      color: var(--color-info);
    }
    .stat-warning {
      color: var(--color-warning);
    }
    .stat-error {
      color: var(--color-error);
    }
    .stat-critical {
      color: var(--color-error);
    }

    /* ── Severity bar ───────────────────────────────── */
    .severity-bar {
      display: flex;
      height: 8px;
      border-radius: var(--radius-full);
      overflow: hidden;
      background: var(--color-border-subtle);
      margin-bottom: var(--space-xl);
    }

    .severity-segment {
      height: 100%;
      transition: width var(--duration-slow) var(--ease-out);
    }

    .severity-critical {
      background: var(--color-error);
    }
    .severity-error {
      background: var(--red-400);
    }
    .severity-warning {
      background: var(--color-warning);
    }
    .severity-info {
      background: var(--color-info);
    }

    /* ── Tabs ───────────────────────────────────────── */
    .tabs {
      display: flex;
      gap: 0;
      border-bottom: 1px solid var(--color-border);
      margin-bottom: var(--space-lg);
    }

    .tab {
      padding: var(--space-sm) var(--space-lg);
      font-size: var(--text-sm);
      font-weight: var(--font-weight-medium);
      color: var(--color-text-muted);
      cursor: pointer;
      border: none;
      background: none;
      border-bottom: 2px solid transparent;
      transition:
        color var(--duration-fast),
        border-color var(--duration-fast);
      font-family: inherit;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
    }

    .tab:hover {
      color: var(--color-text);
    }

    .tab[aria-selected="true"] {
      color: var(--color-primary);
      border-bottom-color: var(--color-primary);
    }

    .tab-count {
      font-size: var(--text-xs);
      color: var(--color-text-faint);
      margin-left: var(--space-xs);
    }

    /* ── Loading / Empty ────────────────────────────── */
    .loading,
    .not-found {
      color: var(--color-text-muted);
      text-align: center;
      padding: var(--space-2xl);
    }

    .pulse {
      animation: pulse 1.5s ease-in-out infinite;
    }

    @keyframes pulse {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0.4;
      }
    }
  `;

  private renderSeverityBar() {
    const stats = this.session?.findingsStats;
    if (!stats) return nothing;

    const total = Object.values(stats).reduce((sum, n) => sum + n, 0);
    if (total === 0) return nothing;

    const segments: { severity: Severity; count: number }[] = [
      { severity: "critical", count: stats.critical ?? 0 },
      { severity: "error", count: stats.error ?? 0 },
      { severity: "warning", count: stats.warning ?? 0 },
      { severity: "info", count: stats.info ?? 0 },
    ];

    return html`
      <div class="severity-bar">
        ${segments
          .filter((s) => s.count > 0)
          .map(
            (s) => html`
              <div
                class="severity-segment severity-${s.severity}"
                style="width: ${(s.count / total) * 100}%"
                title="${s.severity}: ${s.count}"
              ></div>
            `,
          )}
      </div>
    `;
  }

  private renderStats() {
    const s = this.session!;
    const fs = s.findingsStats;

    return html`
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-number">${s.pagesTotal}</div>
          <div class="stat-label">Total Pages</div>
        </div>
        <div class="stat-card">
          <div class="stat-number">${s.pagesVisited}</div>
          <div class="stat-label">Visited</div>
        </div>
        <div class="stat-card">
          <div class="stat-number">${s.sitemapStats.tested ?? 0}</div>
          <div class="stat-label">Tested</div>
        </div>
        <div class="stat-card">
          <div class="stat-number stat-critical">${fs.critical ?? 0}</div>
          <div class="stat-label">Critical</div>
        </div>
        <div class="stat-card">
          <div class="stat-number stat-error">${fs.error ?? 0}</div>
          <div class="stat-label">Errors</div>
        </div>
        <div class="stat-card">
          <div class="stat-number stat-warning">${fs.warning ?? 0}</div>
          <div class="stat-label">Warnings</div>
        </div>
        <div class="stat-card">
          <div class="stat-number stat-info">${fs.info ?? 0}</div>
          <div class="stat-label">Info</div>
        </div>
      </div>
    `;
  }

  private tabHref(tab: Tab): string {
    return `/sessions/${this.sessionId}/${tab}`;
  }

  private navigateTo(href: string, e: Event): void {
    e.preventDefault();
    if (location.pathname === href) return;
    history.pushState({}, "", href);
    // @lit-labs/router subscribes to popstate; emit one to trigger re-render.
    dispatchEvent(new PopStateEvent("popstate"));
  }

  render() {
    if (this.loading) {
      return html`<p class="loading pulse">Loading session…</p>`;
    }

    if (!this.session) {
      return html`
        <a class="back" href="/">← Back to sessions</a>
        <p class="not-found">Session not found.</p>
      `;
    }

    const s = this.session;
    const duration = s.completedAt
      ? formatDuration(s.completedAt - s.startedAt)
      : formatDuration(Date.now() - s.startedAt);

    return html`
      <a class="back" href="/">← Back to sessions</a>

      <div class="session-header">
        <div class="session-title-row">
          <span class="session-url">${s.targetUrl}</span>
          <span class="badge badge-${s.status}">${s.status}</span>
        </div>
        <div class="session-id">${s.id}</div>
        <div class="meta-row">
          <span><span class="meta-label">Started</span>${formatTimestamp(s.startedAt)}</span>
          <span><span class="meta-label">Duration</span>${duration}</span>
          <span><span class="meta-label">Max pages</span>${s.maxPages}</span>
          ${s.completedAt
            ? html`<span><span class="meta-label">Completed</span>${timeAgo(s.completedAt)}</span>`
            : nothing}
        </div>
      </div>

      ${this.renderSeverityBar()} ${this.renderStats()}

      <div class="tabs" role="tablist">
        ${(
          [
            { id: "findings", label: "Findings", count: this.findings.length },
            { id: "features", label: "Features", count: this.features.length },
            {
              id: "plans",
              label: "Test Plans",
              count: this.features.filter((f) => f.activePlan !== null).length,
            },
            { id: "runs", label: "Runs", count: this.runs.length },
            { id: "sitemap", label: "Sitemap", count: this.sitemap.length },
            { id: "chat", label: "Chat", count: this.chatMessages.length },
          ] as { id: Tab; label: string; count: number }[]
        ).map(
          (t) => html`
            <a
              class="tab"
              role="tab"
              href=${this.tabHref(t.id)}
              aria-selected="${this.activeTab === t.id}"
              @click=${(e: Event) => this.navigateTo(this.tabHref(t.id), e)}
            >
              ${t.label}<span class="tab-count">${t.count}</span>
            </a>
          `,
        )}
      </div>

      ${this.activeTab === "findings"
        ? html`<kea-findings-table .findings=${this.findings}></kea-findings-table>`
        : this.activeTab === "features"
          ? html`<kea-features-tab .features=${this.features}></kea-features-tab>`
          : this.activeTab === "plans"
            ? html`<kea-plans-tab .features=${this.features}></kea-plans-tab>`
            : this.activeTab === "runs"
              ? html`<kea-runs-tab .runs=${this.runs}></kea-runs-tab>`
              : this.activeTab === "sitemap"
                ? html`<kea-sitemap-table .entries=${this.sitemap}></kea-sitemap-table>`
                : html`<kea-chat-thread
                    .messages=${this.chatMessages}
                    ?live=${this.session?.status === "running"}
                  ></kea-chat-thread>`}
    `;
  }
}
