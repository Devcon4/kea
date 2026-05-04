# FDD-0001: Automated Site Exploration

**Status**: Shipped
**Scope**: agent
**Related ADRs**: [004](../adr/004-stagehand-browser-automation.md), [015](../adr/015-ollama-dev-vllm-prod.md), [021](../adr/021-pi-sdk-as-agent-runtime.md)
**Supersedes**: —

> Operators point Kea at a single URL and walk away. Kea drives a real browser through the site, builds a map of what exists, and exercises each page looking for things that misbehave — without scripts, without per-site configuration, without supervision. Exploration now also includes discovering previously uncatalogued features and verifying initial scenarios within the same session (see [FDD-0010](0010-feature-driven-test-planning.md)).

---

## Problem

Operators responsible for "is the site OK before we ship?" have no scalable way to exercise a site under change. Hand-written end-to-end scripts cost more to maintain than they catch; manual click-throughs miss anything two clicks past the homepage; nightly headless crawlers find broken links but don't *exercise* pages. The Operator wants a single action — give Kea a URL, walk away — and a useful list of what to look at when they come back.

## Users & context

- **Primary actor**: Operator — the engineer or QA lead responsible for "is the site OK before we ship?"
- **Secondary actor**: Site owner — receives the resulting findings indirectly, doesn't drive the crawl.
- **Frequency / context**: Once per release candidate, sometimes nightly. Often started end-of-day to run overnight against a staging environment. The Operator is **not** watching the screen while it runs; they look at results hours later.

## User stories

- **As an** Operator, **I want** to start a crawl by giving Kea one URL, **so that** I don't have to write or maintain test scripts to get coverage of my site.
- **As an** Operator, **I want** Kea to keep going on its own when an unexpected page or layout appears, **so that** a single oddity doesn't waste the whole crawl.
- **As an** Operator, **I want** the crawl to stop after a budget I set, **so that** an overnight run finishes by morning and doesn't hammer my site indefinitely.
- **As an** Operator, **I want** Kea to stay inside the site I told it to test, **so that** it doesn't wander onto third-party properties (analytics, payment gateways, social embeds) and waste budget or trip alarms.

## Requirements

### Functional

- The system **MUST** accept a single starting URL plus a page budget and begin exploration without further input.
- The system **MUST** discover new pages by following links it finds on pages it has already visited.
- The system **MUST** treat each visited page as a candidate for being exercised (not just catalogued).
- The system **MUST** stop on its own when the budget is exhausted, when no further work remains, or when the Operator cancels.
- The system **MUST** stay on the same site as the starting URL — links to other origins are ignored.
- The system **MUST** detect "this page doesn't really exist" cases (missing pages, pages that redirect away) and not count them against the budget as if they were real pages.
- The system **SHOULD** recover from a single page failing without aborting the crawl.
- The system **SHOULD** prefer reaching new ground over re-visiting pages it already explored, until coverage is exhausted.
- The system **WILL NOT** attempt to log in, fill payment forms, or submit destructive actions on behalf of the Operator.
- The system **WILL NOT** run more than one browser instance per agent process; per-page browser fan-out is not a knob.

### Non-functional

- **Reliability**: A crash inside the LLM planner **MUST NOT** stall the crawl; the crawl falls back to a deterministic next step and continues.
- **Cost**: The system **MUST** stay within a per-crawl LLM call budget rather than scaling calls linearly with pages. The orchestrator drives the LLM in a multi-turn tool-calling loop ([ADR-021](../adr/021-pi-sdk-as-agent-runtime.md)); the system **MUST** rely on prompt caching where the provider exposes it and **MUST** terminate the run when a configured per-session token budget is exhausted, surfacing a truthful failure rather than continuing to spend.
- **Operational**: An Operator **MUST** be able to abort a running crawl cleanly (no orphaned browsers, no half-written state).

## Acceptance criteria

- **Given** the crawl reaches a page exposing a previously uncatalogued feature, **When** the crawl progresses, **Then** the feature appears in the catalogue and at least one scenario is authored under its initial test plan within the same session.
- **Given** a public site, **When** the Operator starts a crawl with a budget of N pages, **Then** the crawl visits at most N distinct same-origin pages and ends in a terminal state ("completed" or "failed") with a populated map of what was found.
- **Given** a page that 404s or redirects to a different URL, **When** the crawl reaches it, **Then** the original URL is dropped from the map (no ghost rows) and budget is not unfairly consumed.
- **Given** the LLM planner returns an unparseable response or errors out, **When** the next planning step is needed, **Then** the crawl continues using a deterministic fallback plan and reaches a terminal state without manual intervention.
- **Given** a link on the target site points to a third-party domain, **When** Kea encounters it, **Then** that link is ignored — no third-party request is initiated by the crawler.
- **Given** the Operator sends a cancel signal, **When** the in-flight page finishes (or is interrupted), **Then** the crawl shuts down within a few seconds, the browser is closed, and the session is marked terminal so the Operator sees a truthful end state.
- **Given** the planner declares the crawl "done" while budget remains and unexplored work exists, **When** that happens, **Then** the system overrides and continues until the real terminal condition is met.

## Alternatives considered

- **Hand-written test scripts (Cypress / Playwright per site)** — rejected: every site needs bespoke scripts; doesn't scale across teams and rots between releases.
- **Pure crawler (no LLM)** — rejected: gets coverage but doesn't *exercise* pages; misses anything that needs interaction or judgement.
- **One LLM call per page** — rejected: cost and latency dominate the run; we want one planning call to drive a batch.
- **Fully autonomous testers without a coordinator** — rejected: testers can't see global progress and re-visit or skip pages incoherently.

## Open questions

- [ ] Should the crawl emit a partial report mid-run, or is end-of-run sufficient for v1? (Currently: end-of-run only — see [FDD-0006](0006-live-agent-activity-stream.md) for partial visibility via live stream.)
- [ ] What's the right default budget? Today the default is 50 pages — does that match real-world usage?

---

## Engineering hand-off

- **Surface area**: lives entirely inside `@kea/agent`. No new public API or UI required by this feature itself; results surface through [FDD-0003](0003-crawl-session-management.md) and [FDD-0004](0004-sitemap-visibility.md).
- **Decisions already pinned**: ADR-021 (Pi runtime drives the multi-turn LLM loop with deterministic-fallback as a tool-call lifecycle interceptor), ADR-004 (Stagehand single-browser), ADR-015 (Ollama dev / vLLM prod).
- **Successor alignment**: feature discovery and initial scenario authoring are defined by [FDD-0010](0010-feature-driven-test-planning.md); this feature's planner flow must invoke that specialist path within the same crawl session.
- **Tests required**: unit coverage for the planner-output parser and the deterministic fallback; integration coverage of cancel + budget-exhaustion termination paths.
- **Cross-cutting rule**: planner output is the only authoritative source of "what to do next" — except when the planner declares done while work remains, in which case the loop overrides.

---

## Cross-references

- **Related FDDs**: [0002](0002-pluggable-specialist-agents.md), [0003](0003-crawl-session-management.md), [0004](0004-sitemap-visibility.md), [0006](0006-live-agent-activity-stream.md), [0010](0010-feature-driven-test-planning.md)
- **Related ADRs**: [004](../adr/004-stagehand-browser-automation.md), [015](../adr/015-ollama-dev-vllm-prod.md), [021](../adr/021-pi-sdk-as-agent-runtime.md)
