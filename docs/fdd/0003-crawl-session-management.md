# FDD-0003: Crawl Session Management

**Status**: Shipped
**Scope**: project
**Related ADRs**: [020](../adr/020-central-postgresql-api.md), [011](../adr/011-hono-http-server.md), [009](../adr/009-result-type-error-handling.md)
**Supersedes**: —

> Every crawl Kea runs is a **session** — a named, durable record the Operator can start, monitor, look back at, and clean up. Sessions outlive the worker that produced them: if a pod dies, the work it did before the crash is still there.

---

## Problem

A crawl that exists only in the memory of a running worker is a crawl one pod reschedule away from disappearing — the pages explored, the bugs found, the timing data: gone. Operators also need a stable handle to refer to a past run when sharing it with a teammate or pulling it up the next morning. Without a first-class session concept, every crawl is anonymous and disposable; with one, each crawl gets a stable identity, durable storage that survives infrastructure churn, and a clean "delete and it's actually gone" lifecycle.

## Users & context

- **Primary actor**: Operator — the person who starts a crawl, monitors it during run, and reviews results after.
- **Secondary actors**: Maintainer — uses sessions when reproducing bugs; Site owner — referenced indirectly when an Operator shares a session link.
- **Frequency / context**: Multiple sessions per Operator per week; a small team may have hundreds active and historical at any time.

## User stories

- **As an** Operator, **I want** every crawl to have a stable identity from the moment I start it, **so that** I can share a link or refer to it later without ambiguity.
- **As an** Operator, **I want** a crawl's findings, sitemap, and chat log to survive a worker restart, **so that** I never lose work to infrastructure churn.
- **As an** Operator, **I want** to see at a glance whether a crawl is still running, finished cleanly, or failed, **so that** I know what's actionable.
- **As an** Operator, **I want** to delete a session and have everything it owned go with it, **so that** cleanup is one action — not a checklist of orphaned tables.
- **As a** Maintainer, **I want** to reproduce a past session's behavior, **so that** I can debug a regression by pointing at the historical record.

## Requirements

### Functional

- The system **MUST** assign every crawl a stable identifier that exists from start to deletion.
- The system **MUST** persist a session's findings, sitemap progress, and message log to durable storage as the crawl runs — not only at the end.
- The session **MUST** carry an explicit status: running, completed, or failed. Once a session reaches a terminal status, the system **MUST NOT** transition it again.
- The system **MUST** record when a session started and (for terminal sessions) when it ended.
- Deleting a session **MUST** delete everything it owned (sitemap rows, findings, messages) atomically. No orphan rows.
- The system **MUST** reject attempts to register the same session twice — a session is created exactly once.
- A session **MUST** have exactly one writer (the agent that owns it); the system does not coordinate concurrent writers.
- The system **SHOULD** allow an Operator to list, filter, and look up sessions by id.
- The system **SHOULD NOT** expose generic update endpoints that bypass the status state machine; status changes go through dedicated transitions.
- The system **WILL NOT** soft-delete or archive sessions. Delete is delete.
- The system **WILL NOT** support pause/resume; a session runs to completion or is canceled.

### Non-functional

- **Durability**: writes that the worker has acknowledged **MUST** survive a pod restart.
- **Consistency**: a session's owned data is always coherent with its status — a "completed" session has a completion timestamp; a "running" session does not.
- **Operational**: an on-call engineer **MUST** be able to find a specific session by id within seconds and read its current status.
- **Performance**: listing the most recent 100 sessions **SHOULD** return within 1 second on a developer laptop with a populated database.

## Acceptance criteria

- **Given** an Operator starts a new crawl, **When** the request is accepted, **Then** the response includes a stable session identifier the Operator can immediately use to look the session up.
- **Given** a running session, **When** the worker writes a finding, page status update, or chat message, **Then** an Operator querying the session within a couple of seconds sees that data.
- **Given** a worker pod is killed mid-crawl, **When** the pod is restarted or replaced, **Then** all data written before the kill is still queryable on the same session id.
- **Given** a session that has reached "completed" or "failed", **When** any caller attempts to transition its status again, **Then** the request is rejected and the original terminal status is preserved.
- **Given** an Operator deletes a session, **When** the delete completes, **Then** every page, finding, and message that belonged to that session is also gone — with no leftover rows referencing the deleted id.
- **Given** the same session id is registered twice (e.g. retry after timeout), **When** the duplicate request arrives, **Then** the system responds in a way the caller can recognize as "already exists" without creating a second record.

## Alternatives considered

- **Per-pod local SQLite + aggregator job** — rejected: pods are ephemeral; data evaporates on reschedule, and the aggregator is a fragile second moving part. (Originally chosen, see ADR-008; superseded by ADR-020.)
- **Event log only (NATS / Kafka)** — rejected: relational queries (filter by status, look up by id, list recent) are the natural shape; an event log forces every read to rebuild state.
- **Soft-delete with a tombstone column** — rejected: encourages "still queryable but pretending to be gone" bugs; cascade hard-delete is simpler to reason about.

## Open questions

- [ ] Should listing endpoints support pagination beyond a hard cap? Today they return everything; at the scale of months of crawls, that breaks.
- [ ] Do we want a "cancel" action distinct from "fail" on the status state machine, or is the current binary terminal sufficient?

---

## Engineering hand-off

- **Surface area**: HTTP routes on `@kea/api` (session CRUD + transitions); agent talks to the API exclusively over HTTP; dashboard reads via the same routes.
- **Decisions already pinned**: ADR-020 (Postgres is the only durable store, agent has no local DB), ADR-011 (Hono server), ADR-009 (Result type for domain failures).
- **Tests required**: domain unit coverage of status state machine; integration coverage of cascade-delete and idempotent re-registration.

---

## Cross-references

- **Related FDDs**: [0001](0001-automated-site-exploration.md), [0004](0004-sitemap-visibility.md), [0005](0005-findings-reporting.md), [0006](0006-live-agent-activity-stream.md), [0008](0008-operator-dashboard.md)
- **Related ADRs**: [020](../adr/020-central-postgresql-api.md), [011](../adr/011-hono-http-server.md), [009](../adr/009-result-type-error-handling.md)
