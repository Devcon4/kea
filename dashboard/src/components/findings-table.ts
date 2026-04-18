import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { SignalWatcher } from "@lit-labs/signals";
import type { Finding, Severity } from "../services/session.service.js";
import { timeAgo, truncateUrl } from "../utils.js";

type SortField = "timestamp" | "severity" | "url";
type SortDir = "asc" | "desc";

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  error: 1,
  warning: 2,
  info: 3,
};

@customElement("kea-findings-table")
class KeaFindingsTable extends SignalWatcher(LitElement) {
  @property({ type: Array }) findings: Finding[] = [];

  @state() private sortField: SortField = "timestamp";
  @state() private sortDir: SortDir = "desc";
  @state() private filterSeverity: Severity | "" = "";
  @state() private filterUrl = "";

  static styles = css`
    :host {
      display: block;
    }

    /* ── Filters ─────────────────────────────────────── */
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

    .search-input:focus {
      border-color: var(--color-primary);
    }

    .search-input::placeholder {
      color: var(--color-text-faint);
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
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
      transition: color var(--duration-fast);
    }

    th:hover { color: var(--color-text); }

    th .sort-arrow {
      margin-left: var(--space-xs);
      font-size: var(--text-xs);
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

    .col-severity { width: 90px; }
    .col-url { min-width: 180px; }
    .col-agent { width: 100px; }
    .col-action { min-width: 160px; }
    .col-result { min-width: 200px; }
    .col-time { width: 100px; white-space: nowrap; }

    /* ── Severity badges ──────────────────────────────── */
    .severity {
      display: inline-block;
      font-size: var(--text-xs);
      font-weight: var(--font-weight-semibold);
      padding: 2px var(--space-sm);
      border-radius: var(--radius-full);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .severity-critical {
      background: var(--color-critical-muted);
      color: var(--color-critical);
    }

    .severity-error {
      background: var(--color-error-muted);
      color: var(--color-error);
    }

    .severity-warning {
      background: var(--color-warning-muted);
      color: var(--color-warning);
    }

    .severity-info {
      background: var(--color-info-muted);
      color: var(--color-info);
    }

    .url-cell {
      font-family: var(--font-mono);
      font-size: var(--text-xs);
      color: var(--color-text-muted);
      word-break: break-all;
    }

    .agent-cell {
      font-family: var(--font-mono);
      font-size: var(--text-xs);
    }

    .result-cell {
      color: var(--color-text);
      line-height: var(--leading-normal);
    }

    .time-cell {
      color: var(--color-text-muted);
      font-size: var(--text-xs);
    }

    /* ── Empty ────────────────────────────────────────── */
    .empty {
      color: var(--color-text-muted);
      text-align: center;
      padding: var(--space-xl);
      font-style: italic;
    }

    .result-count {
      font-size: var(--text-xs);
      color: var(--color-text-faint);
      margin-left: auto;
    }
  `;

  private getSorted(): Finding[] {
    let filtered = [...this.findings];

    if (this.filterSeverity) {
      filtered = filtered.filter((f) => f.severity === this.filterSeverity);
    }

    if (this.filterUrl) {
      const q = this.filterUrl.toLowerCase();
      filtered = filtered.filter((f) => f.url.toLowerCase().includes(q));
    }

    filtered.sort((a, b) => {
      let cmp = 0;
      switch (this.sortField) {
        case "timestamp":
          cmp = a.timestamp - b.timestamp;
          break;
        case "severity":
          cmp = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
          break;
        case "url":
          cmp = a.url.localeCompare(b.url);
          break;
      }
      return this.sortDir === "desc" ? -cmp : cmp;
    });

    return filtered;
  }

  private toggleSort(field: SortField): void {
    if (this.sortField === field) {
      this.sortDir = this.sortDir === "asc" ? "desc" : "asc";
    } else {
      this.sortField = field;
      this.sortDir = field === "timestamp" ? "desc" : "asc";
    }
  }

  private sortArrow(field: SortField): string {
    if (this.sortField !== field) return "";
    return this.sortDir === "asc" ? "↑" : "↓";
  }

  private toggleSeverityFilter(s: Severity): void {
    this.filterSeverity = this.filterSeverity === s ? "" : s;
  }

  private onUrlFilter(e: Event): void {
    this.filterUrl = (e.target as HTMLInputElement).value;
  }

  private renderRow(f: Finding) {
    return html`
      <tr>
        <td class="col-severity">
          <span class="severity severity-${f.severity}">${f.severity}</span>
        </td>
        <td class="col-url"><span class="url-cell">${truncateUrl(f.url, 50)}</span></td>
        <td class="col-agent"><span class="agent-cell">${f.agentId}</span></td>
        <td class="col-action">${f.action}</td>
        <td class="col-result"><span class="result-cell">${f.result}</span></td>
        <td class="col-time"><span class="time-cell">${timeAgo(f.timestamp)}</span></td>
      </tr>
    `;
  }

  render() {
    const sorted = this.getSorted();
    const severities: Severity[] = ["critical", "error", "warning", "info"];

    return html`
      <div class="toolbar">
        <div class="filter-group">
          ${severities.map(
            (s) => html`
              <button
                class="filter-btn"
                aria-pressed="${this.filterSeverity === s}"
                @click=${() => this.toggleSeverityFilter(s)}
              >
                ${s}
              </button>
            `,
          )}
        </div>
        <input
          class="search-input"
          type="text"
          placeholder="Filter by URL…"
          .value=${this.filterUrl}
          @input=${this.onUrlFilter}
        />
        <span class="result-count">${sorted.length} of ${this.findings.length}</span>
      </div>

      ${sorted.length === 0
        ? html`<p class="empty">No findings${this.filterSeverity || this.filterUrl ? " match filters" : ""}.</p>`
        : html`
            <div class="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th class="col-severity" @click=${() => this.toggleSort("severity")}>
                      Severity<span class="sort-arrow">${this.sortArrow("severity")}</span>
                    </th>
                    <th class="col-url" @click=${() => this.toggleSort("url")}>
                      URL<span class="sort-arrow">${this.sortArrow("url")}</span>
                    </th>
                    <th class="col-agent">Agent</th>
                    <th class="col-action">Action</th>
                    <th class="col-result">Result</th>
                    <th class="col-time" @click=${() => this.toggleSort("timestamp")}>
                      Time<span class="sort-arrow">${this.sortArrow("timestamp")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  ${sorted.map((f) => this.renderRow(f))}
                </tbody>
              </table>
            </div>
          `}
    `;
  }
}
