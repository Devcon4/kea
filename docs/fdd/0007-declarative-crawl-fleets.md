# FDD-0007: Declarative Crawl Fleets

**Status**: Accepted
**Scope**: operator
**Related ADRs**: [003](../adr/003-go-kubebuilder-operator.md), [012](../adr/012-container-security.md), [020](../adr/020-central-postgresql-api.md)
**Supersedes**: —

> A platform team declares "I want N agents continuously testing these targets, on this schedule, with these limits" — and the cluster makes it true. Kea becomes a fleet, not a tool a single Operator runs by hand.

---

## Problem

When a platform team wants Kea covering many sites continuously, the per-Operator-per-crawl model breaks: someone has to remember to start runs, keep them within budget, and notice when one falls over at 4am. The team needs to express "test these targets, this much, this often" once — as Kubernetes Custom Resources alongside everything else they already manage — and let the cluster keep that declaration true through reconciliation, self-healing, and clean cascade deletion.

## Users & context

- **Primary actor**: Platform Engineer running Kea as shared infrastructure for multiple application teams.
- **Secondary actor**: Application team — submits a target description, doesn't manage the agents.
- **Tertiary actor**: SRE / on-call — needs the system to behave when alone.
- **Frequency / context**: Configuration changes are infrequent; runtime is continuous. Failure modes are observed by humans only via metrics/alerts, not interactive use.

## User stories

- **As a** Platform Engineer, **I want** to declare a pool of Kea agents in a manifest, **so that** the cluster keeps the right number running without me babysitting them.
- **As a** Platform Engineer, **I want** to declare each target site as its own resource, **so that** application teams can hand me a target without learning the agent internals.
- **As a** Platform Engineer, **I want** to declare a test plan (how often, how long, what budget) bound to a target, **so that** policy lives in the manifest and not in someone's head.
- **As an** SRE, **I want** an agent pod failure to be self-healing, **so that** I'm not paged for transient pod death.
- **As a** Platform Engineer, **I want** deleting a custom resource to cleanly shut down everything it owned, **so that** removing a target means really removing it — not leaving zombie pods or partial state.

## Requirements

### Functional

- The system **MUST** expose three custom resources representing, respectively: a pool of agents, a target site, and a test plan that binds the two.
- The platform **MUST** reconcile the actual state to the declared state on its own — without per-event scripting by the Platform Engineer.
- Reconciliation **MUST** be level-based: regardless of how the system reaches the desired state, repeated reconciliation converges to it.
- The platform **MUST** restart agent pods on failure and replace pods that stop reporting healthy.
- The platform **MUST** apply finalizers so that deletion of a custom resource cleans up the dependent agent pods and any per-pod scratch.
- The platform **MUST** report status on each resource — current pod counts, last reconcile time, observed errors — so an operator inspecting the cluster sees the truth without spelunking logs.
- The platform **SHOULD** scale agent pod counts up or down when the declared pool size changes, without manually deleting and recreating.
- The platform **WILL NOT** persist crawl results in the cluster control plane. State of record stays in the central Postgres API ([FDD-0003](0003-crawl-session-management.md)).
- The platform **WILL NOT** allow a manifest to relax the project's container security profile; security defaults are not a configuration knob.

### Non-functional

- **Reliability**: a single agent pod crash **MUST NOT** affect peer pods or the operator's ability to reconcile.
- **Security**: agent pods **MUST** run with the project's container security profile (non-root, read-only filesystem, dropped capabilities).
- **Operational**: an SRE **MUST** be able to determine why a resource is stuck (pending pods, image-pull failure, transient API outage) by reading its status alone.
- **Local development**: the operator **MUST** be testable without a real cluster; integration tests run against an in-process control plane.

## Acceptance criteria

- **Given** a Platform Engineer applies a pool resource declaring N agents, **When** the operator reconciles, **Then** N healthy agent pods exist, attributed to that resource, with owner references set so deletion cascades.
- **Given** an agent pod crashes, **When** the next reconcile runs, **Then** a replacement pod exists and the resource's status reflects the recovery within a small handful of reconcile cycles.
- **Given** the Platform Engineer changes the declared pool size from N to M, **When** the operator reconciles, **Then** the actual pod count converges to M without intermediate inconsistent states being permanent.
- **Given** the Platform Engineer deletes a custom resource, **When** the operator processes the deletion, **Then** every dependent pod and resource owned by it is gone before the deletion finalizer is removed.
- **Given** the operator cannot reach the central API to confirm a session was registered, **When** reconciling, **Then** the resource's status reflects the failure in human-readable form and the operator retries on the next reconcile rather than wedging.
- **Given** a manifest tries to relax the container security profile (e.g. requesting privileged), **When** the operator processes it, **Then** the request is rejected with an explanatory status — security defaults are not a configuration knob.

## Alternatives considered

- **Cron-driven launcher script** — rejected: no level-based reconciliation, no self-healing, no native cluster integration.
- **Custom in-house controller using raw client-go without Kubebuilder** — rejected: reinvents scaffolding, status subresources, finalizer wiring; no benefit over the standard tool.
- **External orchestrator (Argo Workflows / Tekton)** — rejected: those are pipeline tools, not always-on fleet managers; awkward fit for "keep N agents running."
- **Run agents as bare pods, no operator** — rejected: leaves all the scaling, healing, and lifecycle to humans.

## Open questions

- [ ] Should test plans support recurrence (cron-like schedules), or only "run continuously while the resource exists"?
- [ ] How do we surface budget exhaustion on the resource — degraded status, paused pods, an event, or all three?
- [ ] What's the right backpressure when the central API is degraded? Pause pod creation? Continue and let crawls fail loudly?

---

## Engineering hand-off

- **Surface area**: the operator package (Go, Kubebuilder). New CRDs `AgentPool`, `TargetResource`, `TestPlan` under `chaos.kea.dev/v1alpha1`. No agent-package or dashboard work; the dashboard consumes session state from the central API as usual.
- **Decisions already pinned**: ADR-003 (Go + Kubebuilder), ADR-012 (container security profile), ADR-020 (central Postgres API as system of record — operator does not store results).
- **Tests required**: envtest-based reconcile coverage (create → pods → scale → delete), finalizer cleanup, security-profile rejection.

---

## Cross-references

- **Related FDDs**: [0001](0001-automated-site-exploration.md), [0003](0003-crawl-session-management.md), [0008](0008-operator-dashboard.md)
- **Related ADRs**: [003](../adr/003-go-kubebuilder-operator.md), [012](../adr/012-container-security.md), [020](../adr/020-central-postgresql-api.md)
