# FDD-0002: Pluggable Specialist Agents

**Status**: Superseded by [FDD-0009](0009-pi-extension-specialists.md)
**Scope**: agent
**Related ADRs**: [007](../adr/007-a2a-protocol.md), [005](../adr/005-custom-agent-loop.md)
**Supersedes**: —

> A maintainer can add a new kind of specialist (an accessibility auditor, a visual-diff agent, a content summarizer) and slot it into Kea's exploration loop without rewriting the coordinator or forking the project. New skills graft on; they don't fork.

---

## Problem

Maintainers want to extend Kea with new specialists — an accessibility auditor, a visual-diff agent, a content summarizer — without forking the agent package or modifying the coordinator. Without a published contract for what a specialist is, every extension turns into invasive surgery on the orchestrator, the coordinator becomes a god-object, and contributors stop attempting extensions. The team needs a stable boundary: declare a specialist, hand it the page, get findings back; the rest of Kea need not know anything about the new skill.

## Users & context

- **Primary actor**: Maintainer / Developer extending Kea — internal team or third-party contributor.
- **Secondary actor**: Operator — benefits indirectly (gets richer findings) but doesn't see the extension mechanism.
- **Frequency / context**: Rare event (one new specialist every weeks/months), but high-leverage — the design must hold for years across many specialists.

## User stories

- **As a** Maintainer, **I want** to add a new specialist agent that handles a class of work the existing agents can't, **so that** I extend Kea's coverage without modifying the coordinator or other specialists.
- **As a** Maintainer, **I want** new specialists to use the same protocol existing specialists use, **so that** I don't have to learn a Kea-specific calling convention to hook one in.
- **As a** Maintainer, **I want** specialists to be discoverable at runtime, **so that** tools (debug consoles, integration tests, third-party clients) can introspect what's available without hard-coded lists.
- **As an** Operator, **I want** specialists to fail in isolation, **so that** a buggy new agent doesn't take the rest of the crawl down with it.

## Requirements

### Functional

- The system **MUST** define a single inter-agent protocol that every specialist (existing or new) speaks.
- The system **MUST** provide a way for any agent to publish a machine-readable description of what it does, so callers can discover capability without reading source.
- The system **MUST** let specialists be invoked the same way regardless of whether they live in the same process or a remote one.
- The system **MUST** model each piece of work as a task with explicit lifecycle states the caller can observe (in-progress, completed, failed, canceled).
- The system **MUST** isolate specialist failures: a crash inside one specialist **MUST NOT** corrupt another specialist's state or stop the coordinator.
- The system **SHOULD NOT** invent Kea-proprietary protocol features; it adopts an industry-standard agent-to-agent protocol.
- The system **WILL NOT** expose internal LLM tool-call turns through the inter-agent protocol — only the user-visible request and the specialist's reply cross the boundary.
- The system **WILL NOT** support hot-reload of specialist capability; capability changes require a process restart.

### Non-functional

- **Onboarding**: a new specialist **SHOULD** be addable in a single, self-contained module, with no edits to existing specialists' code.
- **Interop**: any A2A-compliant client **MUST** be able to call a Kea specialist using only its published description, without bespoke Kea knowledge.
- **Observability**: lifecycle transitions for every task **MUST** be observable by tooling (no silent state changes).

## Acceptance criteria

- **Given** a maintainer adds a new specialist module that publishes its description and implements the standard task-handling shape, **When** the agent process starts, **Then** the specialist is discoverable via its description without any change to existing specialists.
- **Given** a specialist task is requested, **When** the work is in progress, **Then** an observer can see the task transition through "submitted → working → terminal" without skipping the working state.
- **Given** a specialist throws an unexpected error mid-task, **When** the task ends, **Then** it terminates as "failed" with a human-readable reason, the coordinator continues operating, and other specialists are unaffected.
- **Given** an external A2A-compliant client (not Kea code) reads a specialist's description and sends a task, **When** the request is well-formed, **Then** the specialist responds successfully without requiring Kea-specific client code.
- **Given** a specialist is asked to coordinate work across multiple other specialists, **When** the request arrives, **Then** the specialist refuses or returns the task to the coordinator — orchestrating peers is **not** a specialist's job.

## Alternatives considered

- **Custom Kea-only protocol** — rejected: proprietary, loses interop with industry tooling, increases onboarding cost for contributors.
- **Model Context Protocol (MCP)** — rejected: MCP is for tool/context serving, not delegated task execution between peer agents.
- **Direct in-process function calls (no protocol)** — rejected: collapses the boundary, prevents cross-process deployment, and prevents external clients from invoking specialists.
- **NATS / gRPC bespoke topics** — rejected: would reinvent task lifecycle, agent discovery, and capability introspection that A2A already standardizes.

## Open questions

- [ ] Once streaming becomes important (long-running specialists like a full a11y audit), do we adopt the A2A streaming extension or build a parallel mechanism?
- [ ] Should specialist version compatibility be enforced at startup (refuse to boot if coordinator and specialist disagree on contract), or surfaced lazily on first call?

---

## Engineering hand-off

- **Surface area**: protocol primitives and types live in `@kea/agent` under `src/a2a/`. Each specialist lives next to the coordinator under `src/agents/`. No `@kea/api` or dashboard work.
- **Decisions already pinned**: ADR-007 (Google A2A v1.0 only — no proprietary protocol). ADR-005 (custom loop is the orchestrator; specialists do not orchestrate peers).
- **Tests required**: unit coverage of the lifecycle invariants (no state-skipping, terminal once terminal); contract test asserting an external A2A client can call each specialist using only the published description.

---

## Cross-references

- **Related FDDs**: [0001](0001-automated-site-exploration.md), [0006](0006-live-agent-activity-stream.md)
- **Related ADRs**: [007](../adr/007-a2a-protocol.md), [005](../adr/005-custom-agent-loop.md)
