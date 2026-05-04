# FDD-0010: Feature-driven Test Planning

**Status**: Accepted
**Scope**: project
**Related ADRs**: [020](../adr/020-central-postgresql-api.md), [021](../adr/021-pi-sdk-as-agent-runtime.md), [022](../adr/022-pi-subagents-extension-model.md), [023](../adr/023-pi-session-manager-postgres.md), [024](../adr/024-features-as-canonical-spec.md)
**Supersedes**: —

> An Operator can describe what their site is supposed to do as a catalogue of features, and Kea verifies those features continue to work over time. Regressions surface as concrete, reproducible failures instead of free-form observations. The agent can also discover features while it crawls; manual authoring and discovered authoring produce the same feature artifact.

---

## Problem

Today, findings are often unanchored observations with self-rated severity rather than evidence tied to a declared expectation. An Operator cannot state, in the product surface, "this site has this capability and it MUST keep working." As a result, regressions are hard to compare across runs because yesterday's observation and today's observation are not guaranteed to describe the same intended behavior.

## Users & context

- **Primary actor**: Operator defining what the site does and reviewing pass/fail evidence.
- **Secondary actor**: Maintainer extending the specialist capabilities (extension model is already covered in [FDD-0009](0009-pi-extension-specialists.md)).
- **Frequency / context**: Continuous crawl operations where reliability depends on repeatable checks, not one-off narrative findings.

## User stories

- **As an** Operator, **I want** to author a feature with seed scenarios, **so that** the agent verifies my highest-risk capabilities from the next run onward.
- **As an** Operator, **I want** newly discovered capabilities to be added to the same feature catalogue during a crawl, **so that** unknown site behavior becomes managed test coverage without separate setup work.
- **As an** Operator, **I want** to see which features are stale and trigger revalidation, **so that** old evidence does not silently masquerade as current truth.
- **As an** Operator, **I want** to see when a previously passing scenario regresses and inspect the reproducing trace, **so that** I can act on concrete failure evidence.

## Requirements

### Functional

- The system **MUST** model features as first-class, session-scoped entities and apply a URL scope language to define where each feature is valid.
- The system **MUST** keep versioned plans under each feature, with at most one active plan at a time.
- The system **MUST** freeze scenarios under a plan revision so historical comparisons remain meaningful.
- The system **MUST** persist run history for every scenario execution.
- The system **MUST** anchor each produced finding to a scenario context whenever available.
- The system **MUST** derive finding severity from actual run outcome, not from model preference.
- The system **MUST** preserve history during revalidation by creating a new revision or retiring the feature rather than overwriting prior records.
- The system **MUST** default to full-suite reruns of active scenarios each coordinator session.
- The system **MUST** ensure manual authoring, discovered authoring, and a future declarative authoring source produce identical feature artifacts.
- The system **SHOULD** fuzzy-match newly discovered capabilities against the existing catalogue to reduce duplicate features.
- The system **WILL NOT** ship dashboard CRUD for features, plans, or scenarios in this FDD; Operators use API surfaces directly until a follow-up FDD lands.
- The system **WILL NOT** ship the declarative cluster authoring path in this FDD; the schema reserve exists, the product surface does not.
- The system **WILL NOT** ship cross-session template libraries in this FDD; feature plans are authored and managed per session.
- The system **WILL NOT** support cross-feature scenario dependencies; scenarios are independent and any sequencing lives inside a single scenario.
- The system **WILL NOT** include visual-diff or accessibility specialist flows in this FDD; those arrive only when separately scoped.
- The system **WILL NOT** add a dedicated replay-only user flow in this FDD; rerun policy knobs cover this operationally for v1.

### Non-functional

- **Performance**: rerun cost **MUST** be visible and tunable to the Operator, with caps that prevent unbounded scenario execution per run.
- **Reliability**: concurrent writers **MUST** serialize revisions and **MUST NOT** drop historical records.
- **Truthfulness**: feature, scenario, and run outcomes **MUST** report what actually happened and **MUST NOT** report plausible-but-false success.

## Acceptance criteria

- **Given** an Operator submits a feature with seed scenarios, **When** the agent runs, **Then** those scenarios appear in the live message stream under tester attribution and produce a run record with pass/fail outcome within 5 minutes.
- **Given** a site exposes a previously uncatalogued feature, **When** the agent crawls a page where that capability appears, **Then** within the same session a new feature record appears and at least one scenario is authored under its initial plan.
- **Given** a scenario passed in run N, **When** run N+1 fails on a step, **Then** the failing step trace is retrievable and the produced finding is anchored to that scenario.
- **Given** a feature has not been verified within its TTL, **When** the Operator inspects the feature catalogue, **Then** the feature status is `stale`; **When** the agent next runs, **Then** revalidation is triggered against any URL in that feature's scope.
- **Given** a feature whose URL scope matches multiple pages, **When** scenario steps transition across those pages, **Then** the run completes successfully across the transitions.
- **Given** the tester crashes mid-scenario, **When** the run completes, **Then** the run result is `error` (never `pass`) and a `warning` finding records the crash.

## Alternatives considered

- **Keep free-form findings as the primary testing output.** Rejected because operators need reproducible regression evidence, not unanchored observations.
- **Define specs per page rather than per feature.** Rejected because many capabilities span multiple pages; page-only specs duplicate intent and break operator mental models.
- **Use an external testing framework outside the crawl loop.** Rejected because discovered capabilities and authored capabilities must converge in one feedback loop, not in separate systems.

## Open questions

- [ ] TTL default is proposed at 14 days; should this shorten once real run cadence data is available?
- [ ] Should stale-confidence be surfaced for scenarios that have not run recently even if the parent feature remains active?

---

## Engineering hand-off

- **Likely surface area**: `@kea/api` Postgres-backed routes and a new planner specialist flow in `@kea/agent`; existing crawl loop and live stream surfaces remain in play.
- **Constraints from existing decisions**: [ADR-020](../adr/020-central-postgresql-api.md), [ADR-022](../adr/022-pi-subagents-extension-model.md), [ADR-023](../adr/023-pi-session-manager-postgres.md), [ADR-024](../adr/024-features-as-canonical-spec.md).
- **Tests required**: unit (domain rules and schema validation), integration (feature/plan/scenario/run API behavior), agent specs (discover and author planner paths, scenario step interpreter), and end-to-end evidence on `sites/blog` with at least one passing scenario run.

---

## Cross-references

- **Related FDDs**: [0001](0001-automated-site-exploration.md), [0005](0005-findings-reporting.md), [0006](0006-live-agent-activity-stream.md), [0009](0009-pi-extension-specialists.md).
- **Related ADRs**: [020](../adr/020-central-postgresql-api.md), [021](../adr/021-pi-sdk-as-agent-runtime.md), [022](../adr/022-pi-subagents-extension-model.md), [023](../adr/023-pi-session-manager-postgres.md), [024](../adr/024-features-as-canonical-spec.md).
