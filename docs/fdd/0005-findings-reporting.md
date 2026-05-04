# FDD-0005: Findings Reporting

**Status**: Shipped
**Scope**: project
**Related ADRs**: [020](../adr/020-central-postgresql-api.md), [009](../adr/009-result-type-error-handling.md)
**Supersedes**: —

> When Kea finds something worth a human's attention — a broken link, a JavaScript error, a form that fails silently — it records a **finding**: a tagged, page-anchored note the Operator can triage, share, and reason about long after the crawl is over. Since [FDD-0010](0010-feature-driven-test-planning.md), tester-emitted findings are also anchored to scenario context when available, and severity is derived from run outcome per [ADR-024](../adr/024-features-as-canonical-spec.md).

---

## Problem

A crawl that surfaces issues only as log lines is a crawl whose value evaporates with the worker's stdout. Operators need a triage queue, not a transcript: each issue a discrete record, anchored to the page that produced it, tagged by category, with enough context to decide in seconds whether it warrants action. Developers picking up an item need enough structured detail to reproduce it without re-running the crawl. None of this is achievable when "findings" live as unstructured log output mixed with progress chatter.

## Users & context

- **Primary actor**: Operator triaging the output of a crawl.
- **Secondary actor**: Developer who'll fix whatever the Operator hands off; needs the finding to carry enough context to reproduce.
- **Frequency / context**: Reviewed at the end of every run, sometimes mid-run if the dashboard shows alarming counts.

## User stories

- **As an** Operator, **I want** every issue Kea surfaces to be a discrete record, **so that** I can triage them one at a time instead of grepping through logs.
- **As an** Operator, **I want** each finding tied to the page it was found on, **so that** I can jump straight to the source instead of guessing.
- **As an** Operator, **I want** findings tagged by category (broken link, console error, accessibility, etc.), **so that** I can filter the queue and prioritize.
- **As a** Developer, **I want** each finding to carry enough context that I can reproduce the issue without re-running the crawl, **so that** I don't waste cycles on regressions that aren't reproducible.
- **As an** Operator, **I want** findings to outlive the agent worker that produced them, **so that** a pod crash doesn't lose the day's triage backlog.

## Requirements

### Functional

- The system **MUST** persist every finding to durable storage attached to the session that produced it.
- Each finding **MUST** be associated with a page in that session's sitemap — orphan findings (no page) are not allowed.
- Each finding **MUST** carry a category (e.g. broken link, console error, content issue) drawn from a closed vocabulary, plus a human-readable description.
- Each finding **MUST** carry a severity signal so the Operator can sort their queue by what matters most.
- When a finding is recorded by the tester specialist, the system **MUST** anchor it to the scenario whose run produced it; severity **MUST** be derived from run outcome (`error` for scenario failure, `warning` for execution crash, `info` for precondition skip); the agent **MUST NOT** invent severity.
- When a scenario is deleted, the system **MUST** preserve findings that referenced it by clearing the scenario anchor to null rather than cascading the finding delete.
- Each finding **SHOULD** carry enough structured context for a developer to reproduce — e.g. URL, surrounding selector, error message — without being so verbose that the queue becomes unreadable.
- The system **MUST** allow listing all findings for a session, filtered by category and/or severity, in a single request.
- The system **MUST NOT** silently de-duplicate findings; if the same issue appears on two pages, both findings exist independently.
- The system **WILL NOT** automatically close, resolve, or assign findings — triage is the human's job.

### Non-functional

- **Durability**: a finding written before a crash **MUST** be retrievable after the worker is replaced.
- **Truthfulness**: a finding's recorded page **MUST** still exist in the session's sitemap when the finding is read; if the page is removed (404/redirect), the system **MUST** make the inconsistency impossible (deletes cascade together). If a referenced scenario is removed, the finding persists and its scenario anchor is cleared to null.
- **Performance**: listing the findings for a session of typical size (≤ 500 pages, ≤ 5,000 findings) **MUST** complete within 1 second.

## Acceptance criteria

- **Given** a scenario fails on a step with reproducible evidence, **When** the run completes, **Then** the resulting finding severity is `error` and the finding is anchored to that scenario id.
- **Given** a finding is anchored to a scenario, **When** that scenario is deleted, **Then** the finding remains and its scenario anchor is cleared to null.
- **Given** an Operator views a finished crawl, **When** they open the findings list, **Then** every issue Kea recorded is present, anchored to a page that appears in the sitemap.
- **Given** the agent attempts to record a finding for a URL that isn't in the sitemap, **When** the request is processed, **Then** the system rejects it — there are no orphan findings.
- **Given** an Operator filters findings by category and severity, **When** the response returns, **Then** every entry matches the filter and the count reflects the filtered total.
- **Given** the worker pod is killed after writing a finding, **When** a new worker takes over (or the Operator opens the dashboard), **Then** that finding is still readable on the same session.
- **Given** the Operator deletes the session, **When** the delete completes, **Then** every finding belonging to that session is gone — no leftover rows referencing the deleted session id.
- **Given** the same finding category occurs on two distinct pages, **When** the Operator lists findings, **Then** both findings are present independently.

## Alternatives considered

- **Findings as log lines only** — rejected: not queryable, lost on rotation, no triage primitive.
- **Findings as free-form text blobs** — rejected: no filtering, no severity sort, no consistent surface.
- **Findings deduplicated by hash** — rejected at this stage: silently merging two real occurrences hides distribution information ("it happens on every product page" vs "it happens once").

## Open questions

- [ ] Should severity be a closed enum (e.g. `info | warn | error`) or a numeric score? Today it's a closed string set.
- [ ] Do we want a "first seen / last seen" pair on findings to support cross-session aggregation later, or is per-session sufficient?

---

## Engineering hand-off

- **Surface area**: findings routes on `@kea/api` (write from agent, read from dashboard); persistence in the same database as sessions and sitemap; scenario anchors on findings are nullable so scenario deletes clear the anchor instead of deleting historical findings.
- **Decisions already pinned**: ADR-020 (central Postgres), ADR-009 (Result type for domain rejections like "page not in sitemap").
- **Tests required**: domain coverage of orphan rejection and derived severity mapping; integration coverage of cascade-delete with the parent session and scenario-delete set-null behavior on findings; filter/list endpoint coverage.

---

## Cross-references

- **Related FDDs**: [0003](0003-crawl-session-management.md), [0004](0004-sitemap-visibility.md), [0006](0006-live-agent-activity-stream.md), [0008](0008-operator-dashboard.md), [0010](0010-feature-driven-test-planning.md)
- **Related ADRs**: [020](../adr/020-central-postgresql-api.md), [009](../adr/009-result-type-error-handling.md), [024](../adr/024-features-as-canonical-spec.md)
