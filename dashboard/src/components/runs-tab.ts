import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { SignalWatcher } from "@lit-labs/signals";
import type {
  ConsoleMessage,
  LlmFailure,
  NetworkFailure,
  PageError,
  RunDiagnostics,
  SessionRunRow,
  StepTraceEntry,
  TestRunResult,
} from "../services/session.service.js";
import { timeAgo, truncateUrl, formatDuration } from "../utils.js";

/**
 * Session-wide Runs tab. Every TestRun in the session, newest first, with
 * scenario + feature context joined at the API layer.
 *
 * Why this exists:
 * - features-tab and plans-tab used to nest run history under each scenario
 *   behind a second-level expander, which buried completed work and made
 *   sessions look idle even when they had finished. Hoisting runs into their
 *   own tab gives them first-class visibility and a place to inspect step
 *   traces without polluting the per-feature view.
 * - One row per run. Click expands to reveal the step trace. Filter by
 *   result so failures and errors can be triaged without scrolling.
 */
@customElement("kea-runs-tab")
class KeaRunsTab extends SignalWatcher(LitElement) {
  @property({ type: Array }) runs: SessionRunRow[] = [];

  @state() private filterResult: TestRunResult | "" = "";
  @state() private expandedRuns = new Set<number>();

  static styles = css`
    :host {
      display: block;
    }

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
      font-family: inherit;
      transition: all var(--duration-fast);
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

    .result-count {
      font-size: var(--text-xs);
      color: var(--color-text-faint);
      margin-left: auto;
    }

    .empty {
      color: var(--color-text-muted);
      text-align: center;
      padding: var(--space-xl);
      font-style: italic;
    }

    .run {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      margin-bottom: var(--space-sm);
      overflow: hidden;
    }

    .run-header {
      display: flex;
      align-items: center;
      gap: var(--space-md);
      padding: var(--space-sm) var(--space-md);
      width: 100%;
      border: none;
      background: none;
      font-family: inherit;
      text-align: left;
      color: var(--color-text);
      cursor: pointer;
      transition: background var(--duration-fast);
    }

    .run-header:hover {
      background: var(--color-surface-elevated, var(--color-surface));
    }

    .run-caret {
      width: 1ch;
      color: var(--color-text-faint);
      flex-shrink: 0;
      font-size: var(--text-xs);
      transition: transform var(--duration-fast);
    }

    .run-caret[data-open] {
      transform: rotate(90deg);
    }

    .run-feature {
      font-weight: var(--font-weight-semibold);
      flex-shrink: 0;
      font-size: var(--text-sm);
    }

    .run-scenario {
      font-size: var(--text-sm);
      color: var(--color-text-muted);
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .run-url {
      font-family: var(--font-mono);
      font-size: var(--text-xs);
      color: var(--color-text-faint);
      flex-shrink: 0;
    }

    .run-time {
      font-size: var(--text-xs);
      color: var(--color-text-faint);
      flex-shrink: 0;
      font-variant-numeric: tabular-nums;
    }

    .run-duration {
      font-size: var(--text-xs);
      color: var(--color-text-faint);
      flex-shrink: 0;
      font-family: var(--font-mono);
    }

    .badge {
      font-size: var(--text-xs);
      font-weight: var(--font-weight-semibold);
      padding: 2px var(--space-sm);
      border-radius: var(--radius-full);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      flex-shrink: 0;
    }
    .run-result-pass {
      background: var(--color-success-muted);
      color: var(--color-success);
    }
    .run-result-fail {
      background: var(--color-error-muted);
      color: var(--color-error);
    }
    .run-result-error {
      background: var(--color-error-muted);
      color: var(--color-error);
    }
    .run-result-skipped {
      background: var(--color-warning-muted);
      color: var(--color-warning);
    }

    /* ── Trace ─────────────────────────────────────── */
    .trace {
      border-top: 1px solid var(--color-border);
      padding: var(--space-sm) var(--space-md);
      background: var(--color-bg);
    }

    .trace-empty {
      font-size: var(--text-xs);
      color: var(--color-text-faint);
      font-style: italic;
    }

    .step {
      display: flex;
      align-items: flex-start;
      gap: var(--space-sm);
      padding: var(--space-xs) 0;
      font-family: var(--font-mono);
      font-size: var(--text-xs);
      border-top: 1px dashed var(--color-border);
    }

    .step:first-child {
      border-top: none;
    }

    .step-index {
      color: var(--color-text-faint);
      flex-shrink: 0;
      font-variant-numeric: tabular-nums;
      width: 2ch;
    }

    .step-kind {
      font-weight: var(--font-weight-semibold);
      color: var(--color-text);
      flex-shrink: 0;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-size: 10px;
      padding-top: 2px;
    }

    .step-evidence {
      color: var(--color-text-muted);
      flex: 1;
      min-width: 0;
      word-break: break-word;
      white-space: pre-wrap;
    }

    .step-latency {
      color: var(--color-text-faint);
      flex-shrink: 0;
      font-variant-numeric: tabular-nums;
    }

    .finding-link {
      display: inline-block;
      margin-top: var(--space-xs);
      font-size: var(--text-xs);
      color: var(--color-primary);
      text-decoration: none;
    }

    .finding-link:hover {
      text-decoration: underline;
    }

    /* ── Diagnostics panel ─────────────────────────────── */
    .diag {
      display: flex;
      flex-direction: column;
      gap: var(--space-md);
      margin-top: var(--space-sm);
      padding: var(--space-sm);
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
    }
    .diag-header {
      font-size: var(--text-xs);
      font-weight: var(--font-weight-semibold);
      color: var(--color-text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .diag-meta {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 2px var(--space-md);
      font-size: var(--text-xs);
      font-family: var(--font-mono);
      color: var(--color-text-muted);
      word-break: break-all;
    }
    .diag-meta dt {
      color: var(--color-text-faint);
    }
    .diag-meta dd {
      margin: 0;
      color: var(--color-text);
    }
    .diag-screenshot {
      max-width: 100%;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      background: var(--color-bg);
    }
    .diag-section {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
    }
    .diag-section-title {
      font-size: var(--text-xs);
      font-weight: var(--font-weight-semibold);
      color: var(--color-text-muted);
    }
    .diag-list {
      list-style: none;
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
      font-family: var(--font-mono);
      font-size: var(--text-xs);
      max-height: 220px;
      overflow-y: auto;
    }
    .diag-list li {
      padding: 2px var(--space-xs);
      border-left: 2px solid var(--color-border);
      color: var(--color-text-muted);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .diag-list li.console-error,
    .diag-list li.network-fail,
    .diag-list li.page-error {
      border-left-color: var(--color-error);
      color: var(--color-text);
    }
    .diag-list li.console-warn {
      border-left-color: var(--color-warning);
    }
    .diag-empty {
      font-size: var(--text-xs);
      color: var(--color-text-faint);
      font-style: italic;
    }
    .diag-compare {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--space-sm);
      font-family: var(--font-mono);
      font-size: var(--text-xs);
    }
    .diag-compare pre {
      margin: 0;
      padding: var(--space-xs);
      background: var(--color-bg);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      overflow-x: auto;
      max-height: 160px;
    }
    .diag-compare-label {
      color: var(--color-text-faint);
      font-weight: var(--font-weight-semibold);
      margin-bottom: 2px;
    }
    .diag-dom {
      max-height: 180px;
      overflow: auto;
      padding: var(--space-xs);
      background: var(--color-bg);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      font-family: var(--font-mono);
      font-size: var(--text-xs);
      white-space: pre-wrap;
      word-break: break-all;
    }
  `;

  private toggleRun(id: number): void {
    const next = new Set(this.expandedRuns);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.expandedRuns = next;
  }

  private toggleResultFilter(r: TestRunResult): void {
    this.filterResult = this.filterResult === r ? "" : r;
  }

  private getFiltered(): SessionRunRow[] {
    if (!this.filterResult) return this.runs;
    return this.runs.filter((r) => r.result === this.filterResult);
  }

  private renderStep(entry: StepTraceEntry) {
    return html`
      <div class="step">
        <span class="step-index">${entry.index}</span>
        <span class="step-kind">${entry.kind}</span>
        <span class="step-evidence">${entry.evidence}</span>
        <span class="step-latency">${entry.latencyMs}ms</span>
        <span class="badge run-result-${entry.result}">${entry.result}</span>
      </div>
    `;
  }

  private renderRun(run: SessionRunRow) {
    const expanded = this.expandedRuns.has(run.id);
    const duration =
      run.completedAt !== null ? formatDuration(run.completedAt - run.startedAt) : "—";
    return html`
      <div class="run">
        <button
          class="run-header"
          aria-expanded="${expanded}"
          @click=${() => this.toggleRun(run.id)}
        >
          <span class="run-caret" ?data-open=${expanded}>▸</span>
          <span class="badge run-result-${run.result}">${run.result}</span>
          <span class="run-feature">${run.featureName}</span>
          <span class="run-scenario">· ${run.scenarioName}</span>
          <span class="run-url">${truncateUrl(run.scenarioEntryUrl, 32)}</span>
          <span class="run-duration" title="duration">${duration}</span>
          <span class="run-time">${timeAgo(run.startedAt)}</span>
        </button>
        ${expanded
          ? html`
              <div class="trace">
                ${run.stepTrace.length === 0
                  ? html`<div class="trace-empty">No step trace recorded.</div>`
                  : run.stepTrace.map((step) => this.renderStep(step))}
                ${run.findingId !== null
                  ? html`<a class="finding-link" href="#findings">→ finding #${run.findingId}</a>`
                  : nothing}
                ${run.diagnostics ? this.renderDiagnostics(run) : nothing}
              </div>
            `
          : nothing}
      </div>
    `;
  }


  /**
   * Diagnostics rendered only for fail/error runs (the API rejects diagnostics
   * on passing runs, so `run.diagnostics` is null elsewhere). Lays out the
   * screenshot first because that's what an operator scans for, then page
   * meta, expected/observed when present, and finally the captured event lists.
   */
  private renderDiagnostics(run: SessionRunRow) {
    const d = run.diagnostics;
    if (!d) return nothing;
    const hasCompare = d.expected !== undefined || d.observed !== undefined;
    return html`
      <div class="diag">
        <div class="diag-header">Failure diagnostics</div>
        <img
          class="diag-screenshot"
          alt="screenshot at failure"
          src="/api/test-runs/${run.id}/artifacts/screenshot"
          @error=${(e: Event) => {
            // No screenshot was uploaded (capture or upload failed). Hide the
            // broken image rather than surface a 404 placeholder.
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
        <dl class="diag-meta">
          <dt>step</dt>
          <dd>${d.failingStepIndex ?? "—"}</dd>
          <dt>url</dt>
          <dd>${d.pageUrl || "—"}</dd>
          <dt>title</dt>
          <dd>${d.pageTitle || "—"}</dd>
          <dt>captured</dt>
          <dd>${timeAgo(d.capturedAt)}</dd>
        </dl>
        ${hasCompare
          ? html`
              <div class="diag-compare">
                <div>
                  <div class="diag-compare-label">expected</div>
                  <pre>${formatCompareValue(d.expected)}</pre>
                </div>
                <div>
                  <div class="diag-compare-label">observed</div>
                  <pre>${formatCompareValue(d.observed)}</pre>
                </div>
              </div>
            `
          : nothing}
        ${this.renderConsoleSection(d.consoleMessages)}
        ${this.renderPageErrorsSection(d.pageErrors)}
        ${this.renderNetworkSection(d.networkFailures)}
        ${this.renderLlmSection(d.llmFailures ?? [])}
        ${this.renderDomSection(d)}
      </div>
    `;
  }

  private renderConsoleSection(messages: ConsoleMessage[]) {
    return html`
      <div class="diag-section">
        <div class="diag-section-title">console (${messages.length})</div>
        ${messages.length === 0
          ? html`<div class="diag-empty">No console messages.</div>`
          : html`<ul class="diag-list">
              ${messages.map(
                (m) => html`<li class="console-${m.level}">[${m.level}] ${m.text}</li>`,
              )}
            </ul>`}
      </div>
    `;
  }

  private renderPageErrorsSection(errors: PageError[]) {
    return html`
      <div class="diag-section">
        <div class="diag-section-title">page errors (${errors.length})</div>
        ${errors.length === 0
          ? html`<div class="diag-empty">No uncaught page errors.</div>`
          : html`<ul class="diag-list">
              ${errors.map(
                (e) =>
                  html`<li class="page-error">${e.message}${e.stack ? `\n${e.stack}` : ""}</li>`,
              )}
            </ul>`}
      </div>
    `;
  }

  private renderNetworkSection(failures: NetworkFailure[]) {
    return html`
      <div class="diag-section">
        <div class="diag-section-title">network failures (${failures.length})</div>
        ${failures.length === 0
          ? html`<div class="diag-empty">No failed requests.</div>`
          : html`<ul class="diag-list">
              ${failures.map(
                (n) =>
                  html`<li class="network-fail">
                    ${n.method} ${n.url} —
                    ${n.status !== null ? `${n.status} ${n.statusText ?? ""}` : (n.errorText ?? "network error")}
                  </li>`,
              )}
            </ul>`}
      </div>
    `;
  }

  /**
   * LLM-provider failures captured by the agent's fetch interceptor. Empty
   * on healthy runs and on runs that predate the field. Bodies are already
   * truncated at capture time; we render them inside <pre> so JSON payloads
   * stay readable and operators can copy them out.
   */
  private renderLlmSection(failures: LlmFailure[]) {
    return html`
      <div class="diag-section">
        <div class="diag-section-title">llm failures (${failures.length})</div>
        ${failures.length === 0
          ? html`<div class="diag-empty">No LLM provider failures.</div>`
          : html`<ul class="diag-list">
              ${failures.map(
                (f) => html`<li class="network-fail">
                  <div>
                    ${f.method} ${f.url} — ${f.status} (${f.elapsedMs}ms)
                  </div>
                  <details>
                    <summary>request${f.requestBodyTruncated ? " (truncated)" : ""}</summary>
                    <pre class="diag-dom">${f.requestBody}</pre>
                  </details>
                  <details>
                    <summary>response${f.responseBodyTruncated ? " (truncated)" : ""}</summary>
                    <pre class="diag-dom">${f.responseBody}</pre>
                  </details>
                </li>`,
              )}
            </ul>`}
      </div>
    `;
  }

  private renderDomSection(d: RunDiagnostics) {
    return html`
      <div class="diag-section">
        <div class="diag-section-title">
          DOM snapshot${d.domTruncated ? " (truncated)" : ""}
        </div>
        ${d.domSnippet
          ? html`<pre class="diag-dom">${d.domSnippet}</pre>`
          : html`<div class="diag-empty">DOM not captured.</div>`}
      </div>
    `;
  }
  render() {
    if (this.runs.length === 0) {
      return html`<p class="empty">No runs recorded for this session yet.</p>`;
    }

    const filtered = this.getFiltered();
    const filters: TestRunResult[] = ["pass", "fail", "error", "skipped"];

    return html`
      <div class="toolbar">
        <div class="filter-group">
          ${filters.map(
            (r) => html`
              <button
                class="filter-btn"
                aria-pressed="${this.filterResult === r}"
                @click=${() => this.toggleResultFilter(r)}
              >
                ${r}
              </button>
            `,
          )}
        </div>
        <span class="result-count">${filtered.length} of ${this.runs.length}</span>
      </div>
      ${filtered.length === 0
        ? html`<p class="empty">No runs with result "${this.filterResult}".</p>`
        : filtered.map((run) => this.renderRun(run))}
    `;
  }
}


function formatCompareValue(value: unknown): string {
  if (value === undefined) return "—";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}