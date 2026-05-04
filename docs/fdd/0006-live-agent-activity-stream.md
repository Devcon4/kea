# FDD-0006: Live Agent Activity Stream

**Status**: Shipped
**Scope**: project
**Related ADRs**: [020](../adr/020-central-postgresql-api.md), [011](../adr/011-hono-http-server.md), [023](../adr/023-pi-session-manager-postgres.md)
**Supersedes**: —

> While a crawl is running, the Operator can watch Kea think — a live, ordered transcript of what each specialist is doing, what it concluded, and what it decided to do next. The crawl stops being a black box.

---

## Problem

A crawl shown only as a spinner gives the Operator no way to build trust during the run or intervene early when it goes wrong. Operators need a live, ordered transcript of what each specialist just decided so they can confirm sensible behavior or kill a stuck run before it burns the budget. Maintainers need the same transcript as a debugging surface: when the LLM planner starts producing strange decisions, watching its reasoning is the only way to notice the regression.

## Users & context

- **Primary actor**: Operator monitoring a crawl in flight.
- **Secondary actor**: Maintainer debugging an LLM regression; uses the historical stream of a past session to see where reasoning went wrong.
- **Frequency / context**: Opened opportunistically during long runs; reviewed end-to-end when investigating odd behavior.

## User stories

- **As an** Operator, **I want** to see Kea's decisions and observations as they happen, **so that** I can build trust in the run before it finishes — or kill it early when it's clearly going wrong.
- **As an** Operator, **I want** the stream to keep working when I refresh the page, **so that** transient browser hiccups don't cost me the live view.
- **As a** Maintainer, **I want** to scroll back through a finished session's full transcript, **so that** I can debug the reasoning of a crawl that produced surprising findings.
- **As a** Maintainer, **I want** the agent's "thinking" (intermediate reasoning) to be distinguishable from its "speech" (final decisions), **so that** I can collapse one and read the other.

## Requirements

### Functional

- The system **MUST** persist every visible message a Kea agent emits during a session, in the order it was emitted.
- Each message **MUST** be attributable to the agent that produced it (coordinator, navigator, tester, future specialists).
- The system **MUST** distinguish *visible decisions* from *thinking* — both are recorded, but they are separable so the Operator can hide the thinking when they want a clean log.
- The system **MUST** offer a live tail: an Operator opening the stream of a running session **MUST** receive new messages as they arrive without polling manually.
- The Operator **MUST** be able to read the full transcript of any past session.
- The stream **SHOULD** survive a brief network drop and reconnect without the Operator losing position.
- The system **MUST NOT** silently drop messages on the live channel — if a message is recorded, it is reachable through both live and historical reads.
- The system **WILL NOT** offer a write path from the Operator into the agent's chat (no "type back to the agent"). The stream is read-only from the Operator's side.

### Non-functional

- **Latency**: a message persisted by the worker **SHOULD** appear in an Operator's live view within a small handful of seconds. Sub-second realtime is **not** required.
- **Reliability**: a worker restart **MUST NOT** cause already-persisted messages to be lost or duplicated.
- **Truthfulness**: the live stream and the historical transcript of the same session **MUST** agree — there is one canonical message log.

## Acceptance criteria

- **Given** a crawl is running, **When** the Operator opens the live stream, **Then** new messages emitted by any specialist appear within a few seconds without the Operator manually refreshing.
- **Given** the Operator's browser drops connection briefly, **When** it reconnects, **Then** the stream resumes from where it left off — no missing messages, no duplicated ones — without manual recovery.
- **Given** a finished session, **When** the Operator opens its transcript, **Then** they see every message in order and the content matches what was visible during the live run.
- **Given** the Operator wants only final decisions, **When** they hide "thinking", **Then** intermediate reasoning is filtered out and only visible decisions remain.
- **Given** the worker pod is killed mid-crawl, **When** a new worker takes over, **Then** all messages already persisted remain queryable on the same session and the live channel resumes when the new worker emits messages.
- **Given** any message is shown live, **When** the Operator later loads the historical transcript of the same session, **Then** that message is present (no live-only or historical-only messages).

## Alternatives considered

- **WebSocket-based push** — viable, deferred: SSE-with-polling meets today's latency budget with simpler infrastructure; revisit when sub-second matters.
- **Operator polls a list endpoint** — rejected for live use: forces clients to choose between latency and load.
- **Agent stdout tailing** — rejected: not durable, not session-scoped, not queryable, doesn't survive restarts.
- **Storing only "decisions", dropping thinking** — rejected: thinking is critical for debugging LLM regressions; we keep both and let the consumer filter.

## Open questions

- [ ] When latency requirements tighten, do we replace the polling SSE with a push channel, or layer a push channel beside it?
- [ ] Should the transcript include tool-call detail (browser actions taken, LLM prompts) at a "verbose" level, or stay at the visible-decisions level only?

---

## Engineering hand-off

- **Surface area**: per-session message routes on `@kea/api` (write + paginated read + streaming read); dashboard consumer; agent emits on every visible decision and stores thinking alongside.
- **Decisions already pinned**: ADR-020 (Postgres durable log is the single canonical message store), ADR-011 (Hono server), ADR-023 (Pi session events bridge into Postgres via `addMessage`; live and historical surfaces share one source).
- **Tests required**: integration coverage of live-vs-historical equivalence; reconnect-without-gap-or-duplicate; thinking-vs-visible separation.

---

## Cross-references

- **Related FDDs**: [0001](0001-automated-site-exploration.md), [0002](0002-pluggable-specialist-agents.md), [0003](0003-crawl-session-management.md), [0008](0008-operator-dashboard.md)
- **Related ADRs**: [020](../adr/020-central-postgresql-api.md), [011](../adr/011-hono-http-server.md), [023](../adr/023-pi-session-manager-postgres.md)
