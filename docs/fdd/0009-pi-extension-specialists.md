# FDD-0009: Pi-Extension Specialist Agents

**Status**: Accepted
**Scope**: agent
**Related ADRs**: [021](../adr/021-pi-sdk-as-agent-runtime.md), [022](../adr/022-pi-subagents-extension-model.md), [023](../adr/023-pi-session-manager-postgres.md)
**Supersedes**: [FDD-0002](0002-pluggable-specialist-agents.md)

> A Maintainer can add a new kind of specialist (an accessibility auditor, a visual-diff agent, a content summarizer) and slot it into Kea's exploration loop without rewriting the coordinator or forking the project. New skills graft on; they don't fork. The product promise is unchanged from [FDD-0002](0002-pluggable-specialist-agents.md); the implementation contract is now Pi sub-agents instead of in-process A2A peers.

---

## Problem

Maintainers want to extend Kea with new specialists — an accessibility auditor, a visual-diff agent, a content summarizer — without forking the agent package or modifying the coordinator. The previous contract (FDD-0002) framed each specialist as an A2A peer; in practice that boundary was never crossed at process scope, every "remote" call was an in-process function dressed up as HTTP, and the protocol cost (Agent Cards, task lifecycle plumbing, JSON-RPC framing) was paid for nothing visible. The team also adopted a runtime ([ADR-021](../adr/021-pi-sdk-as-agent-runtime.md)) that already provides delegation, isolation, and lifecycle management for child agents — re-implementing those primitives on top of A2A duplicated work that is now native.

Maintainers still need a stable boundary: declare a specialist, hand it the page (or the planning state), get a structured result back; the rest of Kea need not know anything about the new skill. What's changing is the shape of that boundary, not the promise.

## Users & context

- **Primary actor**: Maintainer / Developer extending Kea — internal team or third-party contributor.
- **Secondary actor**: Operator — benefits indirectly (gets richer findings) but doesn't see the extension mechanism.
- **Frequency / context**: Rare event (one new specialist every weeks/months), but high-leverage — the design must hold for years across many specialists.

## User stories

- **As a** Maintainer, **I want** to add a new specialist agent that handles a class of work the existing agents can't, **so that** I extend Kea's coverage without modifying the coordinator or other specialists.
- **As a** Maintainer, **I want** a new specialist to be declarable in a single self-contained module, **so that** review and revert are local — one file added, one file removed.
- **As a** Maintainer, **I want** a specialist's failure (thrown error, exhausted budget, malformed output) to surface as a structured result the parent can react to, **so that** a buggy new specialist doesn't take the rest of the crawl down with it.
- **As an** Operator, **I want** a specialist's decisions to appear in the live message stream attributed to that specialist, **so that** a richer Kea is also a more legible Kea.

## Requirements

### Functional

- The system **MUST** let a Maintainer add a specialist as a single self-contained module, without modifying the coordinator's source or any other specialist's source.
- The system **MUST** define a specialist by three things only: a typed parameter shape, a description the parent's planner can read, and an implementation that runs the specialist's work and returns a structured result.
- The system **MUST** isolate specialist failures: a specialist that throws, exhausts its budget, or returns a malformed result **MUST** surface as a structured error to the parent without affecting siblings or terminating the parent's run.
- The system **MUST** attribute every visible decision a specialist emits to that specialist by name in the [live message stream](0006-live-agent-activity-stream.md), so an Operator can read a richer transcript without losing legibility.
- The system **MUST** observe a per-specialist budget (turns, tokens, or time) and terminate the specialist with a truthful failure when it runs over.
- The system **WILL NOT** support hot-reload of specialist capability; the available specialists are fixed at process startup and changes require a rebuild and restart. (Per [ADR-012](../adr/012-container-security.md), the agent's runtime filesystem is read-only; runtime extension installation is explicitly not a supported surface.)
- The system **WILL NOT** expose specialists as a network-callable surface for clients outside the agent process. (If genuine cross-pod agent traffic ever becomes a real need — see [FDD-0007](0007-declarative-crawl-fleets.md) — that is a separate FDD with a separate wire protocol; this FDD's promise is in-process extension only.)
- The system **WILL NOT** allow a specialist to orchestrate peer specialists. Coordination is the orchestrator's job; a specialist that needs another specialist's output returns to the orchestrator and lets it dispatch the next call.

### Non-functional

- **Onboarding**: a Maintainer reading the existing specialists **SHOULD** be able to add a new one with no documentation beyond the existing examples.
- **Observability**: every specialist invocation **MUST** emit a start and end record visible in the message stream, with the specialist's identity and the outcome (success / failure with reason).
- **Truthfulness**: a specialist's reported result **MUST NOT** lie. A specialist that didn't run, ran partially, or hit its budget surfaces that fact rather than returning a plausible-but-empty success.

## Acceptance criteria

- **Given** a Maintainer adds a new specialist module that declares its parameter shape, description, and implementation, **When** the agent process starts, **Then** the orchestrator can invoke the specialist by name without any change to other specialists' source.
- **Given** a specialist throws an unexpected error mid-run, **When** the orchestrator's tool call returns, **Then** it returns as a structured failure with a human-readable reason, the orchestrator continues operating, and other specialists are unaffected.
- **Given** a specialist exceeds its configured turn or token budget, **When** the budget is exhausted, **Then** the specialist terminates with a truthful "budget exhausted" failure, the orchestrator sees the failure, and no partial result is reported as success.
- **Given** a specialist emits a visible decision, **When** an Operator opens the [live message stream](0006-live-agent-activity-stream.md), **Then** that decision appears attributed to the specialist (not to the orchestrator) and the historical transcript shows the same attribution.
- **Given** a specialist tries to invoke another specialist directly, **When** the call is made, **Then** the system either disallows the call at startup or the specialist is rewritten to return to the orchestrator — peers do not coordinate peers.

## Alternatives considered

- **Keep [FDD-0002](0002-pluggable-specialist-agents.md)'s A2A-peer contract.** Rejected: in-process A2A imitates a network boundary that doesn't exist. The protocol cost (Agent Cards, task lifecycle, JSON-RPC framing) bought nothing observable, and we already have a native delegation mechanism via the agent runtime. See [ADR-022](../adr/022-pi-subagents-extension-model.md).
- **Maintain both contracts side-by-side (A2A peers and Pi sub-agents).** Rejected: two parallel "how do you add a capability" stories with no defensible criterion for choosing between them. Every contributor would have to learn both. This is the design-integrity failure called out in the team's coding contract — one concept, one representation.
- **Expose specialists over a wire protocol now, in case cross-pod talk becomes useful later.** Rejected as premature. There is zero cross-pod agent traffic today. Carrying that surface "in case" violates "delete on the way in." If [FDD-0007](0007-declarative-crawl-fleets.md) grows the need, it becomes a separate, scoped FDD with explicit cross-pod semantics, not a concession we maintain pre-emptively.
- **Treat each specialist as an MCP tool server.** Rejected: MCP serves tools and context to a single agent, not delegated multi-turn task execution between agents. Wrong abstraction.

## Open questions

- [ ] Should specialist budgets be uniform (one knob per process) or per-specialist (declared on the module)? Today: per-module, defaults shared, override at registration.
- [ ] How does the Operator-visible name of a specialist map to its implementation module? Today: by string id declared in the module — same source-of-truth as the message-stream attribution. Worth revisiting if attribution drift shows up in practice.

---

## Engineering hand-off

- **Surface area**: specialists live inside `@kea/agent`. The runtime primitives come from [ADR-021](../adr/021-pi-sdk-as-agent-runtime.md); registration is a tool definition on the orchestrator's session per [ADR-022](../adr/022-pi-subagents-extension-model.md). The dashboard's [live stream](0006-live-agent-activity-stream.md) consumer is unchanged — attribution flows through the existing message log per [ADR-023](../adr/023-pi-session-manager-postgres.md).
- **Reference specialists**: the planner specialist (two modes: discover and author) and the tester specialist are the baseline implementations this contract is exercised through.
- **Contract boundary**: a specialist's complete contract is the subset of tools it exposes — skill equals tool subset ([ADR-022](../adr/022-pi-subagents-extension-model.md), [FDD-0010](0010-feature-driven-test-planning.md)).
- **Budgets by mode**: planner-discover is capped at ≤6 tool-call turns, planner-author at ≤8, and tester at `4 + 2 × step_count` (rationale in [FDD-0010](0010-feature-driven-test-planning.md)).
- **Decisions already pinned**: [ADR-021](../adr/021-pi-sdk-as-agent-runtime.md) (Pi as the agent runtime), [ADR-022](../adr/022-pi-subagents-extension-model.md) (Pi sub-agents as the extension contract), [ADR-023](../adr/023-pi-session-manager-postgres.md) (Postgres remains canonical truth), [ADR-012](../adr/012-container-security.md) (no runtime filesystem extension installation).
- **Tests required**: unit coverage for the failure-isolation path (specialist throws → structured tool error, sibling unaffected); unit coverage for the budget-exhaustion path; an end-to-end check that a new specialist's decisions appear in the live message stream attributed to that specialist.

---

## Cross-references

- **Supersedes**: [FDD-0002](0002-pluggable-specialist-agents.md) — same product promise, new implementation contract.
- **Related FDDs**: [0001](0001-automated-site-exploration.md), [0006](0006-live-agent-activity-stream.md), [0007](0007-declarative-crawl-fleets.md), [0010](0010-feature-driven-test-planning.md).
- **Related ADRs**: [021](../adr/021-pi-sdk-as-agent-runtime.md), [022](../adr/022-pi-subagents-extension-model.md), [023](../adr/023-pi-session-manager-postgres.md), [012](../adr/012-container-security.md).
