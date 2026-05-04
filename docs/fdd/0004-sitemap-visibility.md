# FDD-0004: Sitemap Visibility

**Status**: Shipped
**Scope**: project
**Related ADRs**: [020](../adr/020-central-postgresql-api.md)
**Supersedes**: —

> While a crawl runs, the Operator can see *what Kea has found and what it's done about it*: which pages were discovered, which were visited, which were exercised. The sitemap is the truthful surface that turns a black-box crawl into something the Operator can reason about live and review afterward.

---

## Problem

A long-running crawl with no visibility is indistinguishable from a stuck one. Operators need to know whether the crawl is reaching the parts of the site they care about, what state each page is in, and whether the time invested so far has produced real coverage. Without a structured per-session sitemap, the only available signals are "is the worker pod alive" and "did the run finish" — neither of which lets an Operator decide whether to let a run continue or kill it.

## Users & context

- **Primary actor**: Operator monitoring or reviewing a crawl.
- **Secondary actor**: Maintainer reproducing a bug — uses the sitemap to confirm a specific page was reached.
- **Frequency / context**: Operator opens the dashboard mid-crawl, glances at the sitemap; or after the run, walks through the list when triaging findings.

## User stories

- **As an** Operator, **I want** to see every page Kea has discovered in the running crawl, **so that** I can tell whether it's reaching the parts of the site I care about.
- **As an** Operator, **I want** to see what state each page is in (just discovered, visited, exercised), **so that** I can tell at a glance how much real work has been done.
- **As an** Operator, **I want** pages that turned out to be 404s or external redirects to be removed from my sitemap, **so that** my coverage view isn't cluttered with non-pages.
- **As an** Operator, **I want** the same URL written two slightly different ways to count as one page, **so that** my numbers match my mental model of the site.
- **As a** Maintainer, **I want** to manually mark a page as "needs to be re-tested," **so that** I can re-run a specific page without restarting the whole crawl.

## Requirements

### Functional

- The system **MUST** record every URL Kea encounters during a crawl, scoped to the session in which it was discovered.
- Each page in the sitemap **MUST** carry an explicit status — *discovered*, *visited*, or *tested* — that reflects the deepest level of work Kea has done on it.
- Status **MUST** advance monotonically through that order. The system **MUST NOT** silently downgrade a page's status.
- The system **MUST** provide an explicit "re-open" action that resets a page back to *discovered* — this is the only sanctioned way to revisit a page after it has been worked on.
- The system **MUST** remove a URL from the sitemap when Kea determines it is not a real page (404 or redirect to a different URL).
- The system **MUST** apply a consistent normalization rule so that trivially different spellings of the same URL (default port, trailing slash on root) collapse into one entry.
- The system **MUST** keep sitemaps per session — the same URL appearing in two different crawls is two independent rows.
- The system **SHOULD** expose summary counts (total / discovered / visited / tested) without requiring the caller to enumerate every page.
- The system **WILL NOT** crawl beyond the same site — links to other origins are filtered out before they reach the sitemap.
- The system **WILL NOT** deduplicate URLs across sessions; each crawl owns its own sitemap.

### Non-functional

- **Performance**: fetching the sitemap for an in-progress crawl with hundreds of pages **MUST** complete within 1 second on a developer laptop.
- **Truthfulness**: the summary counts **MUST** equal the sum of pages in each status. If the numbers disagree, the system has a bug — the surface must not paper over it.

## Acceptance criteria

- **Given** a running crawl, **When** the Operator views the sitemap, **Then** every URL Kea has touched appears exactly once with a status reflecting its current depth of work.
- **Given** a page Kea has marked *tested*, **When** any caller attempts to set its status back to *discovered* or *visited* through normal operations, **Then** the request is rejected — only the explicit re-open action transitions it backwards.
- **Given** Kea visits a URL that returns a 404 or redirects to a different URL, **When** the visit completes, **Then** the original URL is removed from the sitemap rather than left in a misleading state.
- **Given** the same page is referenced as `https://example.com/` and `https://example.com:443/`, **When** Kea processes both, **Then** they appear as a single entry — the sitemap doesn't double-count them.
- **Given** the Operator is looking at the live sitemap, **When** they request a summary, **Then** the totals add up: discovered + visited + tested equals the total page count, with no rows in any other state.
- **Given** a link on a target-site page points to `https://thirdparty.com/...`, **When** Kea extracts links, **Then** that URL never appears in the sitemap.

## Alternatives considered

- **Global URL table + session join table** — rejected: deduplicates URLs across crawls at the cost of complicating cascade rules and per-session state.
- **Free-form status (any string)** — rejected: a closed enum is testable; an open string drifts.
- **404 detection by HTTP status only** — open as a future improvement; today the heuristic is title-based, accepted as good enough until counter-examples accumulate.
- **Allowing manual status downgrades** — rejected: hides bugs. The explicit re-open action makes the intent visible.

## Open questions

- [ ] Should the sitemap expose a "depth from start URL" metric so Operators can see how far Kea has reached into the site?
- [ ] When a page is removed (404/redirect), should we keep a tombstone the Operator can inspect, or is silent removal sufficient?

---

## Engineering hand-off

- **Surface area**: per-session sitemap routes on `@kea/api`; URL normalization in `@kea/shared`; agent writes through the API only.
- **Decisions already pinned**: ADR-020 (central Postgres). Cascade delete with the parent session is owned by [FDD-0003](0003-crawl-session-management.md).
- **Tests required**: domain coverage of status transitions (including rejection of downgrades); integration coverage of normalization and 404/redirect removal; assertion that summary counts equal the sum of statuses.

---

## Cross-references

- **Related FDDs**: [0001](0001-automated-site-exploration.md), [0003](0003-crawl-session-management.md), [0005](0005-findings-reporting.md), [0008](0008-operator-dashboard.md)
- **Related ADRs**: [020](../adr/020-central-postgresql-api.md)
