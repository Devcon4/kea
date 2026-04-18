import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { SignalWatcher } from "@lit-labs/signals";
import type { SitemapEntry, PageStatus } from "../services/session.service.js";
import { timeAgo, truncateUrl } from "../utils.js";

@customElement("kea-sitemap-table")
class KeaSitemapTable extends SignalWatcher(LitElement) {
  @property({ type: Array }) entries: SitemapEntry[] = [];

  @state() private filterStatus: PageStatus | "" = "";
  @state() private filterUrl = "";

  static styles = css`
    :host {
      display: block;
    }

    /* ── Toolbar ──────────────────────────────────────── */
    .toolbar {
      display: flex;
      gap: var(--space-md);
      margin-bottom: var(--space-md);
      flex-wrap: wrap;
      align-items: center;
    }

    .filter-group {
      display: flex;
      gap: var(--space-xs);
    }

    .filter-btn {
      font-size: var(--text-xs);
      font-weight: var(--font-weight-medium);
      padding: var(--space-xs) var(--space-sm);
      border-radius: var(--radius-full);
      border: 1px solid var(--color-border);
      background: transparent;
      color: var(--color-text-muted);
      cursor: pointer;
      transition: all var(--duration-fast);
      font-family: inherit;
    }

    .filter-btn:hover {
      border-color: var(--color-text-muted);
      color: var(--color-text);
    }

    .filter-btn[aria-pressed="true"] {
      border-color: var(--color-primary);
      background: var(--color-primary-muted);
      color: var(--color-primary);
    }

    .search-input {
      font-size: var(--text-sm);
      padding: var(--space-xs) var(--space-sm);
      border-radius: var(--radius-sm);
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      color: var(--color-text);
      font-family: var(--font-mono);
      outline: none;
      transition: border-color var(--duration-fast);
      min-width: 200px;
    }

    .search-input:focus { border-color: var(--color-primary); }
    .search-input::placeholder { color: var(--color-text-faint); }

    .result-count {
      font-size: var(--text-xs);
      color: var(--color-text-faint);
      margin-left: auto;
    }

    /* ── Table ────────────────────────────────────────── */
    .table-wrapper {
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    th {
      text-align: left;
      font-size: var(--text-xs);
      font-weight: var(--font-weight-semibold);
      color: var(--color-text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: var(--space-sm) var(--space-md);
      border-bottom: 1px solid var(--color-border);
      white-space: nowrap;
    }

    td {
      padding: var(--space-sm) var(--space-md);
      border-bottom: 1px solid var(--color-border-subtle);
      font-size: var(--text-sm);
      vertical-align: top;
    }

    tr:hover td {
      background: var(--color-surface-hover);
    }

    /* ── Status badges ───────────────────────────────── */
    .status {
      display: inline-block;
      font-size: var(--text-xs);
      font-weight: var(--font-weight-semibold);
      padding: 2px var(--space-sm);
      border-radius: var(--radius-full);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .status-discovered {
      background: var(--color-warning-muted);
      color: var(--color-warning);
    }

    .status-visited {
      background: var(--color-primary-muted);
      color: var(--color-primary);
    }

    .status-tested {
      background: var(--color-success-muted);
      color: var(--color-success);
    }

    .url-cell {
      font-family: var(--font-mono);
      font-size: var(--text-xs);
      word-break: break-all;
    }

    .title-cell {
      color: var(--color-text);
      max-width: 300px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .links-cell {
      color: var(--color-text-muted);
      font-size: var(--text-xs);
    }

    .time-cell {
      color: var(--color-text-muted);
      font-size: var(--text-xs);
      white-space: nowrap;
    }

    .empty {
      color: var(--color-text-muted);
      text-align: center;
      padding: var(--space-xl);
      font-style: italic;
    }
  `;

  private getFiltered(): SitemapEntry[] {
    let result = [...this.entries];

    if (this.filterStatus) {
      result = result.filter((e) => e.status === this.filterStatus);
    }

    if (this.filterUrl) {
      const q = this.filterUrl.toLowerCase();
      result = result.filter(
        (e) => e.url.toLowerCase().includes(q) || e.title.toLowerCase().includes(q),
      );
    }

    // Sort: tested first, then visited, then discovered
    const statusOrder: Record<PageStatus, number> = { tested: 0, visited: 1, discovered: 2 };
    result.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

    return result;
  }

  private toggleStatusFilter(s: PageStatus): void {
    this.filterStatus = this.filterStatus === s ? "" : s;
  }

  private onUrlFilter(e: Event): void {
    this.filterUrl = (e.target as HTMLInputElement).value;
  }

  private renderRow(entry: SitemapEntry) {
    return html`
      <tr>
        <td>
          <span class="status status-${entry.status}">${entry.status}</span>
        </td>
        <td><span class="url-cell">${truncateUrl(entry.url, 60)}</span></td>
        <td><span class="title-cell">${entry.title || "—"}</span></td>
        <td><span class="links-cell">${entry.links.length}</span></td>
        <td><span class="time-cell">${timeAgo(entry.discoveredAt)}</span></td>
        <td>
          <span class="time-cell">
            ${entry.visitedAt ? timeAgo(entry.visitedAt) : "—"}
          </span>
        </td>
      </tr>
    `;
  }

  render() {
    const filtered = this.getFiltered();
    const statuses: PageStatus[] = ["discovered", "visited", "tested"];

    return html`
      <div class="toolbar">
        <div class="filter-group">
          ${statuses.map(
            (s) => html`
              <button
                class="filter-btn"
                aria-pressed="${this.filterStatus === s}"
                @click=${() => this.toggleStatusFilter(s)}
              >
                ${s}
              </button>
            `,
          )}
        </div>
        <input
          class="search-input"
          type="text"
          placeholder="Filter by URL or title…"
          .value=${this.filterUrl}
          @input=${this.onUrlFilter}
        />
        <span class="result-count">${filtered.length} of ${this.entries.length}</span>
      </div>

      ${filtered.length === 0
        ? html`<p class="empty">No pages${this.filterStatus || this.filterUrl ? " match filters" : ""}.</p>`
        : html`
            <div class="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>URL</th>
                    <th>Title</th>
                    <th>Links</th>
                    <th>Discovered</th>
                    <th>Visited</th>
                  </tr>
                </thead>
                <tbody>
                  ${filtered.map((e) => this.renderRow(e))}
                </tbody>
              </table>
            </div>
          `}
    `;
  }
}
