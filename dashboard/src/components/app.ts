import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { SignalWatcher } from "@lit-labs/signals";
import { provide } from "@lit/context";
import { Router } from "@lit-labs/router";
import { sessionServiceContext } from "../contexts.js";
import { SessionService } from "../services/session.service.js";
import { toSignal } from "../rxjs-interop.js";
import "./session-list.js";
import "./session-detail.js";

@customElement("kea-app")
class KeaApp extends SignalWatcher(LitElement) {
  @provide({ context: sessionServiceContext })
  @state()
  sessionService = new SessionService();

  private activeCount = toSignal(this.sessionService.activeCount$, 0);
  private totalFindings = toSignal(this.sessionService.totalFindings$, 0);

  private pollSub = this.sessionService.startPolling();

  private router = new Router(this, [
    {
      path: "/",
      render: () => html`<kea-session-list></kea-session-list>`,
    },
    {
      path: "/sessions/:id",
      render: ({ id }) =>
        html`<kea-session-detail .sessionId=${id}></kea-session-detail>`,
    },
  ]);

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.pollSub();
    this.activeCount[1]();
    this.totalFindings[1]();
  }

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--space-md) var(--space-xl);
      border-bottom: 1px solid var(--color-border);
      background: var(--color-surface);
    }

    .header-inner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      max-width: 1200px;
      margin: 0 auto;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: var(--space-lg);
    }

    .logo {
      font-size: var(--font-size-xl);
      font-weight: 700;
      color: var(--color-primary);
    }

    .stats {
      display: flex;
      gap: var(--space-lg);
      font-size: var(--font-size-sm);
      color: var(--color-text-muted);
    }

    .stat-value {
      font-weight: 600;
      color: var(--color-text);
      margin-left: var(--space-xs);
    }

    nav {
      display: flex;
      gap: var(--space-md);
    }

    nav a {
      font-size: var(--font-size-sm);
      padding: var(--space-xs) var(--space-sm);
      border-radius: var(--radius-sm);
      transition: background var(--duration-fast), color var(--duration-fast);
      color: var(--color-text-muted);
      text-decoration: none;
    }

    nav a:hover {
      background: var(--color-surface-hover);
      color: var(--color-text);
      text-decoration: none;
    }

    nav a[aria-current="page"] {
      color: var(--color-primary);
      background: var(--color-primary-muted);
    }

    main {
      flex: 1;
      padding: var(--space-xl);
      max-width: 1200px;
      margin: 0 auto;
      width: 100%;
    }
  `;

  render() {
    return html`
      <header>
        <div class="header-inner">
          <div class="header-left">
            <span class="logo">Kea</span>
            <nav>
              <a href="/" aria-current=${location.pathname === "/" ? "page" : "false"}>Sessions</a>
            </nav>
          </div>
          <div class="stats">
            <span>
              Active agents:
              <span class="stat-value">${this.activeCount[0].get()}</span>
            </span>
            <span>
              Findings:
              <span class="stat-value">${this.totalFindings[0].get()}</span>
            </span>
          </div>
        </div>
      </header>
      <main>
        ${this.router.outlet()}
      </main>
    `;
  }
}
