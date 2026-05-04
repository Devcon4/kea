import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { SignalWatcher } from "@lit-labs/signals";
import type {
  FeatureWithActivePlan,
  FeatureStatus,
  ScenarioWithLatestRun,
  TestRunResult,
} from "../services/session.service.js";
import { timeAgo, truncateUrl } from "../utils.js";

/**
 * Surfaces the FDD-0010 feature graph for a session.
 *
 * Design intent:
 * - One level of disclosure. Feature cards expand to reveal their scenarios;
 *   scenarios do NOT have a second-level run-history expander (that lives in
 *   the Runs tab now). Two-level nesting trained operators to assume a card
 *   was empty when it wasn't.
 * - Run state is eagerly visible. Each scenario shows the result of its
 *   latest run (pass/fail/error/unrun) without any further interaction —
 *   regression-safe because the API attaches `latestRun` to every scenario
 *   in the listing payload.
 */
@customElement("kea-features-tab")
class KeaFeaturesTab extends SignalWatcher(LitElement) {
  @property({ type: Array }) features: FeatureWithActivePlan[] = [];

  @state() private filterStatus: FeatureStatus | "" = "";
  @state() private expandedFeatures = new Set<number>();

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

    .result-count {
      font-size: var(--text-xs);
      color: var(--color-text-faint);
      margin-left: auto;
    }

    /* ── Feature card ─────────────────────────────────── */
    .feature {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      margin-bottom: var(--space-md);
      overflow: hidden;
    }

    .feature-header {
      display: flex;
      align-items: center;
      gap: var(--space-md);
      padding: var(--space-md) var(--space-lg);
      cursor: pointer;
      width: 100%;
      border: none;
      background: none;
      font-family: inherit;
      text-align: left;
      color: var(--color-text);
      transition: background var(--duration-fast);
    }

    .feature-header:hover {
      background: var(--color-surface-elevated, var(--color-surface));
    }

    .feature-caret {
      font-size: var(--text-xs);
      color: var(--color-text-faint);
      width: 1ch;
      flex-shrink: 0;
      transition: transform var(--duration-fast);
    }

    .feature-caret[data-open] {
      transform: rotate(90deg);
    }

    .feature-name {
      font-weight: var(--font-weight-semibold);
      font-size: var(--text-md);
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /*
     * Aggregate run state at the card level so the operator can scan a long
     * feature list and immediately see "5/5 passing", "2/3 + 1 unrun", etc.
     * Without this, you had to expand each card to discover what state its
     * scenarios were in.
     */
    .feature-roll-up {
      display: inline-flex;
      gap: var(--space-2xs);
      flex-shrink: 0;
      font-family: var(--font-mono);
      font-size: var(--text-xs);
    }

    .roll-up-chip {
      padding: 1px var(--space-xs);
      border-radius: var(--radius-sm);
      font-variant-numeric: tabular-nums;
    }

    .roll-up-pass {
      background: var(--color-success-muted);
      color: var(--color-success);
    }
    .roll-up-fail {
      background: var(--color-error-muted);
      color: var(--color-error);
    }
    .roll-up-unrun {
      background: var(--color-border-subtle);
      color: var(--color-text-muted);
    }

    .feature-meta {
      display: flex;
      gap: var(--space-xs);
      align-items: center;
      flex-shrink: 0;
    }

    .badge {
      font-size: var(--text-xs);
      font-weight: var(--font-weight-semibold);
      padding: 2px var(--space-sm);
      border-radius: var(--radius-full);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .badge-active {
      background: var(--color-success-muted);
      color: var(--color-success);
    }
    .badge-stale {
      background: var(--color-warning-muted);
      color: var(--color-warning);
    }
    .badge-retired {
      background: var(--color-border-subtle);
      color: var(--color-text-muted);
    }

    .chip {
      font-size: var(--text-xs);
      padding: 2px var(--space-sm);
      border-radius: var(--radius-sm);
      background: var(--color-border-subtle);
      color: var(--color-text-muted);
      font-family: var(--font-mono);
    }

    /* ── Feature body ─────────────────────────────────── */
    .feature-body {
      padding: var(--space-md) var(--space-lg) var(--space-lg);
      border-top: 1px solid var(--color-border);
    }

    .feature-description {
      font-size: var(--text-sm);
      color: var(--color-text-muted);
      margin-bottom: var(--space-md);
    }

    .url-patterns {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-xs);
      margin-bottom: var(--space-md);
    }

    .plan-meta {
      font-size: var(--text-xs);
      color: var(--color-text-faint);
      margin-bottom: var(--space-sm);
    }

    /* ── Scenario row (single level, no expander) ─────── */
    .scenario-list {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
    }

    .scenario {
      display: flex;
      align-items: center;
      gap: var(--space-md);
      padding: var(--space-sm) var(--space-md);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      font-size: var(--text-sm);
    }

    .scenario-name {
      font-weight: var(--font-weight-medium);
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .scenario-url {
      font-size: var(--text-xs);
      color: var(--color-text-faint);
      font-family: var(--font-mono);
      flex-shrink: 0;
    }

    .scenario-time {
      font-size: var(--text-xs);
      color: var(--color-text-faint);
      flex-shrink: 0;
      font-variant-numeric: tabular-nums;
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
    .run-result-unrun {
      background: var(--color-border-subtle);
      color: var(--color-text-faint);
    }

    .empty,
    .scenarios-empty {
      color: var(--color-text-muted);
      text-align: center;
      padding: var(--space-md);
      font-style: italic;
      font-size: var(--text-sm);
    }

    .empty {
      padding: var(--space-xl);
    }
  `;

  private getFiltered(): FeatureWithActivePlan[] {
    if (!this.filterStatus) return this.features;
    return this.features.filter((row) => row.feature.status === this.filterStatus);
  }

  private toggleFeature(id: number): void {
    const next = new Set(this.expandedFeatures);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.expandedFeatures = next;
  }

  private toggleStatusFilter(s: FeatureStatus): void {
    this.filterStatus = this.filterStatus === s ? "" : s;
  }

  /**
   * Bucket a feature's scenarios into pass / fail+error / unrun. Folded into
   * a single chip group on the header; "fail" intentionally absorbs "error"
   * because both surfaces want operator attention and a third color would
   * out-bid the actual feature status badge.
   */
  private rollUp(scenarios: ScenarioWithLatestRun[]): {
    pass: number;
    fail: number;
    unrun: number;
  } {
    let pass = 0;
    let fail = 0;
    let unrun = 0;
    for (const scenario of scenarios) {
      const result = scenario.latestRun?.result;
      if (result === "pass") pass += 1;
      else if (result === "fail" || result === "error") fail += 1;
      else unrun += 1;
    }
    return { pass, fail, unrun };
  }

  private renderRunBadge(scenario: ScenarioWithLatestRun) {
    const result: TestRunResult | "unrun" = scenario.latestRun?.result ?? "unrun";
    return html`<span class="badge run-result-${result}">${result}</span>`;
  }

  private renderScenario(scenario: ScenarioWithLatestRun) {
    const run = scenario.latestRun;
    return html`
      <div class="scenario">
        ${this.renderRunBadge(scenario)}
        <span class="scenario-name">${scenario.name}</span>
        <span class="scenario-url">${truncateUrl(scenario.entryUrl, 40)}</span>
        ${run
          ? html`<span class="scenario-time" title="latest run">${timeAgo(run.startedAt)}</span>`
          : nothing}
      </div>
    `;
  }

  private renderRollUp(scenarios: ScenarioWithLatestRun[]) {
    if (scenarios.length === 0) return nothing;
    const { pass, fail, unrun } = this.rollUp(scenarios);
    return html`
      <span class="feature-roll-up" aria-label="scenario run roll-up">
        ${pass > 0
          ? html`<span class="roll-up-chip roll-up-pass" title="passing">${pass}✓</span>`
          : nothing}
        ${fail > 0
          ? html`<span class="roll-up-chip roll-up-fail" title="failing or errored">${fail}✗</span>`
          : nothing}
        ${unrun > 0
          ? html`<span class="roll-up-chip roll-up-unrun" title="not yet run">${unrun}·</span>`
          : nothing}
      </span>
    `;
  }

  private renderFeature(row: FeatureWithActivePlan) {
    const f = row.feature;
    const expanded = this.expandedFeatures.has(f.id);
    const scenarios = row.activePlan?.scenarios ?? [];

    return html`
      <div class="feature">
        <button
          class="feature-header"
          aria-expanded="${expanded}"
          @click=${() => this.toggleFeature(f.id)}
        >
          <span class="feature-caret" ?data-open=${expanded}>▸</span>
          <span class="feature-name">${f.name}</span>
          ${this.renderRollUp(scenarios)}
          <span class="feature-meta">
            <span class="chip" title="discovered by">${f.discoveredBy}</span>
            <span class="badge badge-${f.status}">${f.status}</span>
          </span>
        </button>
        ${expanded
          ? html`
              <div class="feature-body">
                ${f.description
                  ? html`<div class="feature-description">${f.description}</div>`
                  : nothing}
                ${f.urlPatterns.length > 0
                  ? html`
                      <div class="url-patterns">
                        ${f.urlPatterns.map((p) => html`<span class="chip">${p}</span>`)}
                      </div>
                    `
                  : nothing}
                ${row.activePlan
                  ? html`
                      <div class="plan-meta">
                        Active plan: revision ${row.activePlan.plan.revision} · created by
                        ${row.activePlan.plan.createdBy}
                      </div>
                      ${scenarios.length === 0
                        ? html`<div class="scenarios-empty">Plan has no scenarios.</div>`
                        : html`<div class="scenario-list">
                            ${scenarios.map((s) => this.renderScenario(s))}
                          </div>`}
                    `
                  : html`<div class="plan-meta">No active test plan.</div>`}
              </div>
            `
          : nothing}
      </div>
    `;
  }

  render() {
    const filtered = this.getFiltered();
    const statuses: FeatureStatus[] = ["active", "stale", "retired"];

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
        <span class="result-count">${filtered.length} of ${this.features.length}</span>
      </div>

      ${filtered.length === 0
        ? html`<p class="empty">
            No features${this.filterStatus ? ` with status "${this.filterStatus}"` : " yet"}.
          </p>`
        : filtered.map((row) => this.renderFeature(row))}
    `;
  }
}
