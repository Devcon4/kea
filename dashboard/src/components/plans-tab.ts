import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { SignalWatcher } from "@lit-labs/signals";
import type {
  FeatureWithActivePlan,
  ScenarioWithLatestRun,
  ScenarioStep,
  TestRunResult,
} from "../services/session.service.js";
import { timeAgo, truncateUrl } from "../utils.js";

/**
 * Plan-first view of a session. Lists every feature that currently has an
 * active TestPlan and surfaces its scenarios + steps inline.
 *
 * Design intent:
 * - Steps are always visible. Plans are short by construction (≤3 scenarios
 *   per feature, ≤6 steps per scenario), so collapsing them defeats the
 *   purpose of a "plan-first" view. The two-level expander hid the content
 *   the operator came to read.
 * - Run state is eager. Each scenario's latest result is rendered as a chip
 *   without a follow-up GET; full run history lives in the Runs tab.
 */
@customElement("kea-plans-tab")
class KeaPlansTab extends SignalWatcher(LitElement) {
  @property({ type: Array }) features: FeatureWithActivePlan[] = [];

  static styles = css`
    :host {
      display: block;
    }

    .empty {
      color: var(--color-text-muted);
      text-align: center;
      padding: var(--space-xl);
      font-style: italic;
    }

    .plan-card {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      padding: var(--space-md) var(--space-lg);
      margin-bottom: var(--space-md);
    }

    .plan-header {
      display: flex;
      align-items: baseline;
      gap: var(--space-md);
      margin-bottom: var(--space-sm);
      flex-wrap: wrap;
    }

    .feature-name {
      font-weight: var(--font-weight-semibold);
      font-size: var(--text-md);
    }

    .plan-meta {
      color: var(--color-text-muted);
      font-size: var(--text-xs);
    }

    .chip {
      font-size: var(--text-xs);
      background: var(--color-surface-elevated, var(--color-surface));
      border: 1px solid var(--color-border);
      border-radius: var(--radius-full);
      padding: 0 var(--space-sm);
      color: var(--color-text-muted);
    }

    .scenario {
      border-top: 1px dashed var(--color-border);
      padding-top: var(--space-sm);
      margin-top: var(--space-sm);
    }

    .scenario-header {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      padding: var(--space-xs) 0;
    }

    .scenario-name {
      font-weight: var(--font-weight-medium);
      font-size: var(--text-sm);
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .scenario-url {
      font-family: var(--font-mono);
      font-size: var(--text-xs);
      color: var(--color-text-muted);
      flex-shrink: 0;
    }

    .scenario-time {
      font-size: var(--text-xs);
      color: var(--color-text-faint);
      flex-shrink: 0;
      font-variant-numeric: tabular-nums;
    }

    .steps {
      list-style: none;
      padding: var(--space-xs) 0 var(--space-xs) var(--space-md);
      margin: 0;
      font-family: var(--font-mono);
      font-size: var(--text-xs);
      color: var(--color-text-muted);
    }

    .step {
      padding: var(--space-xs) 0;
    }

    .step-kind {
      font-weight: var(--font-weight-semibold);
      color: var(--color-text);
      margin-right: var(--space-sm);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-size: 10px;
    }

    .badge {
      font-size: 10px;
      font-weight: var(--font-weight-semibold);
      padding: 1px var(--space-sm);
      border-radius: var(--radius-full);
      text-transform: uppercase;
      letter-spacing: 0.05em;
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
      color: var(--color-text-muted);
    }
  `;

  private getPlans(): FeatureWithActivePlan[] {
    return this.features.filter((row) => row.activePlan !== null);
  }

  private renderRunBadge(scenario: ScenarioWithLatestRun) {
    const result: TestRunResult | "unrun" = scenario.latestRun?.result ?? "unrun";
    return html`<span class="badge run-result-${result}">${result}</span>`;
  }

  private renderStep(step: ScenarioStep) {
    const detail = (() => {
      switch (step.kind) {
        case "navigate":
          return step.url;
        case "act":
          return step.verifyWith
            ? `${step.instruction} · verify: ${step.verifyWith}`
            : step.instruction;
        case "observe":
          return `${step.question} · expect ${step.expect.kind}`;
        case "extract":
          return `${Object.keys(step.schema).join(", ") || "{}"}${step.bind ? ` → $${step.bind}` : ""}`;
      }
    })();
    return html` <li class="step"><span class="step-kind">${step.kind}</span>${detail}</li> `;
  }

  private renderScenario(scenario: ScenarioWithLatestRun) {
    const run = scenario.latestRun;
    return html`
      <div class="scenario">
        <div class="scenario-header">
          ${this.renderRunBadge(scenario)}
          <span class="scenario-name">${scenario.name}</span>
          <span class="scenario-url">${truncateUrl(scenario.entryUrl, 40)}</span>
          ${run
            ? html`<span class="scenario-time" title="latest run">${timeAgo(run.startedAt)}</span>`
            : ""}
        </div>
        <ul class="steps">
          ${scenario.steps.map((s) => this.renderStep(s))}
        </ul>
      </div>
    `;
  }

  private renderPlan(row: FeatureWithActivePlan) {
    const plan = row.activePlan!.plan;
    const scenarios = row.activePlan!.scenarios;
    return html`
      <div class="plan-card">
        <div class="plan-header">
          <span class="feature-name">${row.feature.name}</span>
          <span class="chip">feature #${row.feature.id}</span>
          <span class="chip">plan rev ${plan.revision}</span>
          <span class="chip">${plan.createdBy}</span>
          <span class="chip">${scenarios.length} scenario${scenarios.length === 1 ? "" : "s"}</span>
          <span class="plan-meta">${timeAgo(plan.createdAt)}</span>
        </div>
        ${scenarios.length === 0
          ? html`<div class="plan-meta">Plan has no scenarios.</div>`
          : scenarios.map((s) => this.renderScenario(s))}
      </div>
    `;
  }

  render() {
    const plans = this.getPlans();
    if (plans.length === 0) {
      return html`<p class="empty">No active test plans yet.</p>`;
    }
    return html`${plans.map((row) => this.renderPlan(row))}`;
  }
}
