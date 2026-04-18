import { LitElement, html, css, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import { SignalWatcher } from "@lit-labs/signals";
import { Signal } from "signal-polyfill";
import { consume } from "@lit/context";
import { sessionServiceContext } from "../contexts.js";
import { type SessionService, type SessionWithStats } from "../services/session.service.js";
import { toSignal } from "../rxjs-interop.js";
import { timeAgo, truncateUrl } from "../utils.js";

@customElement("kea-session-list")
class KeaSessionList extends SignalWatcher(LitElement) {
  @consume({ context: sessionServiceContext, subscribe: true })
  sessionService!: SessionService;

  private sessions!: [Signal.State<SessionWithStats[]>, () => void];

  connectedCallback(): void {
    super.connectedCallback();
    this.sessions = toSignal(this.sessionService.sessions$, [] as SessionWithStats[]);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.sessions[1]();
  }

  static styles = css`
    :host {
      display: block;
    }

    .page-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--space-xl);
    }

    h2 {
      font-size: var(--text-xl);
      font-weight: var(--font-weight-bold);
    }

    .session-count {
      font-size: var(--text-sm);
      color: var(--color-text-muted);
    }

    .empty {
      color: var(--color-text-muted);
      font-style: italic;
      text-align: center;
      padding: var(--space-2xl);
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
      gap: var(--space-md);
    }

    .card {
      display: block;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      padding: var(--space-lg);
      transition: background var(--duration-normal) var(--ease-out),
                  border-color var(--duration-normal) var(--ease-out),
                  box-shadow var(--duration-normal) var(--ease-out);
      cursor: pointer;
      color: inherit;
      text-decoration: none;
    }

    .card:hover {
      background: var(--color-surface-hover);
      border-color: var(--color-primary);
      box-shadow: var(--shadow-md);
      text-decoration: none;
    }

    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--space-sm);
      gap: var(--space-sm);
    }

    .card-url {
      font-family: var(--font-mono);
      font-size: var(--text-sm);
      color: var(--color-text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }

    .badge {
      font-size: var(--text-xs);
      font-weight: var(--font-weight-semibold);
      padding: var(--space-xs) var(--space-sm);
      border-radius: var(--radius-full);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      white-space: nowrap;
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

    .card-id {
      font-size: var(--text-xs);
      color: var(--color-text-faint);
      font-family: var(--font-mono);
      margin-bottom: var(--space-sm);
    }

    .card-meta {
      font-size: var(--text-xs);
      color: var(--color-text-muted);
      margin-bottom: var(--space-md);
    }

    .card-stats {
      display: flex;
      gap: var(--space-lg);
      font-size: var(--text-sm);
      color: var(--color-text-muted);
    }

    .card-stat-value {
      color: var(--color-text);
      font-weight: var(--font-weight-semibold);
    }

    .progress-bar {
      height: 4px;
      background: var(--color-border-subtle);
      border-radius: var(--radius-full);
      margin-top: var(--space-md);
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      border-radius: var(--radius-full);
      transition: width var(--duration-slow) var(--ease-out);
    }

    .progress-running { background: var(--color-success); }
    .progress-completed { background: var(--color-primary); }
    .progress-failed { background: var(--color-error); }
  `;

  private renderCard(session: SessionWithStats) {
    const progress =
      session.pagesTotal > 0
        ? (session.pagesVisited / session.pagesTotal) * 100
        : 0;

    return html`
      <a class="card" href="/sessions/${session.id}">
        <div class="card-header">
          <span class="card-url">${truncateUrl(session.targetUrl)}</span>
          <span class="badge badge-${session.status}">${session.status}</span>
        </div>
        <div class="card-id">${session.id}</div>
        <div class="card-meta">
          Started ${timeAgo(session.startedAt)}
          · Max ${session.maxPages} pages
        </div>
        <div class="card-stats">
          <span>
            Pages
            <span class="card-stat-value">
              ${session.pagesVisited}/${session.pagesTotal}
            </span>
          </span>
          <span>
            Findings
            <span class="card-stat-value">${session.findingsCount}</span>
          </span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill progress-${session.status}" style="width: ${progress}%"></div>
        </div>
      </a>
    `;
  }

  render() {
    const sessions = this.sessions[0].get();
    return html`
      <div class="page-header">
        <h2>Sessions</h2>
        ${sessions.length > 0
          ? html`<span class="session-count">${sessions.length} session${sessions.length !== 1 ? "s" : ""}</span>`
          : nothing}
      </div>
      ${sessions.length === 0
        ? html`<p class="empty">No sessions yet. Start an agent to see activity here.</p>`
        : html`<div class="grid">${sessions.map((s: SessionWithStats) => this.renderCard(s))}</div>`}
    `;
  }
}
