# ADR-024: Features as the Canonical Test Specification

**Status**: Accepted
**Scope**: project

## Context

Kea's current tester loop free-associates over a capped text snapshot and emits findings whose severity is often LLM-invented rather than outcome-derived. That yields observations, but not a reproducible contract: there is no explicit answer to "what was supposed to be true," no stable unit to compare across runs, and no shared storage shape that planner output, operator-authored intent, and future declarative sources can all converge on. The tools-as-actions specialist model adopted in [ADR-022](022-pi-subagents-extension-model.md) and promised in [FDD-0009](../fdd/0009-pi-extension-specialists.md) is the right execution architecture; what is missing is the canonical unit of testable intent.

## Decision

**Features are first-class per-session entities, and every test artifact hangs from that model.**

Concretely:

- A **Feature** represents a logical capability (for example, a shopping cart) that may span multiple URLs.
- Features are created by multiple writers using one schema: planner discovery, operator-authored API input, and future declarative/dashboard writers.
- Feature scope is expressed with **URLPattern** strings.
- Feature lifecycle is explicit: `active | stale | retired`.
- Feature provenance is explicit: `planner | manual | crd` (CRD path deferred, source value reserved now).

- A Feature owns versioned **TestPlans**.
- TestPlan revisions are **append-only**; history is preserved.
- At most one TestPlan revision per Feature is `active`; older active revisions become `superseded` when replaced.

- A TestPlan revision owns frozen **Scenarios**.
- A Scenario contains name, entry URL, ordered steps, and expected outcome.
- Supported step kinds are `navigate`, `act`, `observe`, and `extract`.
- `extract` may bind named values for later `${name}` substitution in subsequent steps.
- Assertions are structured by default (`equal` / `regex`) with opt-in `semantic` assertions for LLM-judged checks.

- **TestRuns** persist per Scenario with full step trace, latency, and terminal result (`pass | fail | skipped | error`).

- **Findings** are anchored to Scenario context (`scenario_id` nullable for legacy rows).
- Finding severity is **derived from outcome**, not authored by the LLM:
  - scenario fail with mismatch evidence -> `error`
  - scenario skipped due to precondition -> `info`
  - tester crash / execution error -> `warning`

- Staleness is explicit and actionable. A Feature becomes stale when explicitly marked, when verification age exceeds TTL (default 14 days), or when at least three consecutive mismatch failures occur.
- Revalidation re-runs discovery against any URL matched by the Feature's URLPatterns and either authors a new TestPlan revision (superseding the prior one) or marks the Feature `retired`.

- Rerun policy defaults to **full-suite**: each coordinator session executes all active scenarios to keep evidence fresh.
- Tunable policy options are supported (`full`, `stale-only`, or skip-if-recently-passed), with hard caps (max 8 steps per scenario, max 5 page transitions per test).

- Scenario execution remains Stagehand-driven through the tester specialist, with step-by-step browser interaction and trace capture.

- Concurrent writers serialize revisions with a unique `(feature_id, revision)` constraint. A collision returns 409; writer retries at `revision + 1`.

This decision extends [ADR-020](020-central-postgresql-api.md), [ADR-021](021-pi-sdk-as-agent-runtime.md), [ADR-022](022-pi-subagents-extension-model.md), and [ADR-023](023-pi-session-manager-postgres.md) by defining the canonical product entity graph those runtime/storage decisions now carry.

## Alternatives Considered

- **Keep the free-associating tester and enrich prompts.** Rejected. Better prompting does not create an anchored, reproducible contract; findings remain unbound to explicit expected behavior and weak for regression detection.

- **Hard-code scenarios in repository code.** Rejected. This blocks operator authoring and makes coverage growth dependent on engineering deploy cycles instead of the product surface the operator manages.

- **Adopt an external test framework as the primary spec.** Rejected. It executes outside the crawler's feature-discovery loop and creates a second writer domain, which conflicts with the single-shared-schema requirement.

- **Model specs per page instead of per Feature.** Rejected. Features regularly cross URL boundaries; page-centric specs duplicate intent, fragment ownership, and lose the abstraction operators reason in.

## Consequences

- Regression detection becomes real and comparable over time: a scenario that passed and later fails is a first-class signal with reproducible trace.
- Operator authoring becomes a supported path: operators can seed features and scenarios directly; planner-authored and operator-authored artifacts are the same shape.
- Future declarative and dashboard writers become straightforward additions because they target the same canonical entities.
- Full-suite default increases per-session execution cost on large catalogs; policy controls and hard caps mitigate but do not remove that cost.
- Revision concurrency is explicit operational behavior: collisions are expected in multi-writer flows and resolved by 409 + retry semantics.
- Legacy findings remain valid with nullable `scenario_id`; no historical backfill is required for correctness.
- LLM-guided action steps remain probabilistic: one re-phrased retry is allowed for `act`; persistent failure is recorded as failure, with no flake-suppression layer that could hide truth.
