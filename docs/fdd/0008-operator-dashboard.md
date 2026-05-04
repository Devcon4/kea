# FDD-0008: Operator Dashboard

**Status**: Shipped
**Scope**: dashboard
**Related ADRs**: [016](../adr/016-lit-web-components.md), [017](../adr/017-rxjs-services-with-signal-bridge.md), [018](../adr/018-lit-context-for-dependency-injection.md), [019](../adr/019-lit-labs-router.md)
**Supersedes**: —

> One web app where the Operator does everything human-facing: see what's running, watch a session live, browse history, drill into a session's sitemap and findings, and share a link to any of it. No CLI required for normal triage.

---

## Problem

Everything Kea produces — sitemaps, findings, message logs, session status — is technically reachable through the API by hand, but that is not a triage workflow. Operators need an opinionated UI that surfaces what ran overnight, makes session status recognizable at a glance, and gives every view a shareable URL. Anything that lives only in someone's local terminal scrollback is information that won't be acted on.

## Users & context

- **Primary actor**: Operator triaging crawls.
- **Secondary actor**: Engineer or stakeholder receiving a shared link to a specific session, finding, or page.
- **Frequency / context**: Multiple times per day during active investigation; less often when only nightly runs are happening. Used on a developer laptop, not a production NOC wall.

## User stories

- **As an** Operator, **I want** to see a list of recent and running sessions on the home page, **so that** I can pick the one to look at without typing a session id anywhere.
- **As an** Operator, **I want** every session, sitemap entry, and finding to have a permalink, **so that** I can paste a URL into a chat and the recipient lands on the same view I'm seeing.
- **As an** Operator, **I want** a session's live state (sitemap progress, new findings, agent activity) to update on the page without me refreshing, **so that** I can leave the dashboard open and trust it.
- **As an** Operator, **I want** to drill from a session into its sitemap, into a single page, into the findings on that page, **so that** triage feels like a hierarchy, not a search.
- **As a** Stakeholder receiving a shared link, **I want** the page to load directly to the relevant view, **so that** I don't have to be re-oriented through the home screen.

## Requirements

### Functional

- The dashboard **MUST** present a session listing showing, at minimum: identifier, target, status, started time, and (for terminal sessions) ended time.
- The dashboard **MUST** offer a per-session detail view that surfaces the live sitemap ([FDD-0004](0004-sitemap-visibility.md)), findings ([FDD-0005](0005-findings-reporting.md)), and the agent activity stream ([FDD-0006](0006-live-agent-activity-stream.md)).
- Every screen the Operator might want to share **MUST** be reachable by URL — direct navigation to a session, a page within a session, or a finding within a session.
- The dashboard **MUST** update live views (running session detail, in-progress sitemap, new findings, message stream) without requiring a manual refresh.
- The dashboard **MUST** read from the central API only. It **MUST NOT** keep its own copy of session state.
- The dashboard **SHOULD** provide a clear empty state ("no sessions yet") and a clear loading state — never a blank screen with no signal.
- The dashboard **SHOULD** make session status visually distinct (running / completed / failed) so it's recognizable at a glance in a dense list.
- The dashboard **WILL NOT** provide write actions on running sessions in v1 (no cancel button, no re-test button, no delete). Read-only triage today.

### Non-functional

- **Performance**: the home page **MUST** render the session list within 1 second on a developer laptop with a populated database (≤ 500 sessions).
- **Resilience**: a transient API outage **MUST** surface a visible error state rather than a blank page or stale data masquerading as fresh.
- **Accessibility**: keyboard navigation **MUST** reach every interactive element; status **MUST NOT** be conveyed by color alone.
- **Truthfulness**: a session shown as "running" in the dashboard **MUST** match the API's notion of "running" — there are no dashboard-only states.
- **Shareability**: every URL the dashboard shows in the address bar **MUST** be loadable directly without going through the home screen first.

## Acceptance criteria

- **Given** the API has running and finished sessions, **When** the Operator opens the home page, **Then** the listing renders within 1 second showing each session's status, target, and timestamps.
- **Given** the Operator clicks into a running session, **When** the worker emits a new finding or visits a new page, **Then** the corresponding panel updates live without a page refresh.
- **Given** the Operator copies the address bar URL while viewing a session, **When** they paste it into a new browser tab, **Then** that tab opens to the same view (deep link works without preamble).
- **Given** the API is unreachable, **When** the Operator opens the dashboard, **Then** they see a clear error state — never a blank page or stale "everything's fine" data.
- **Given** a session has both running and completed siblings, **When** the Operator scans the listing, **Then** status is distinguishable without relying on color alone (icon, label, or other cue).
- **Given** an Operator using only a keyboard, **When** they navigate from session list to session detail to finding, **Then** every step is reachable without a mouse.

## Alternatives considered

- **Server-rendered HTML dashboard** — rejected: live updates would require a parallel push channel anyway, and component reuse is awkward; SPA with a typed component model is closer to the team's strengths.
- **CLI-only triage** — rejected: doesn't satisfy the "share a link" story; doesn't scale to non-engineer stakeholders.
- **Heavy framework (React + state library + UI kit)** — rejected per ADR-016: standard web components keep the surface small and avoid lock-in.

## Open questions

- [ ] When write actions land (cancel, re-run, delete), are they bolt-ons here or a successor FDD?
- [ ] Do we need an "alerting" surface (something that proactively flags new critical findings) or is "open the dashboard" sufficient as the v1 contract?

---

## Engineering hand-off

- **Surface area**: `@kea/dashboard` SPA. Reads live and historical state from `@kea/api` only. No agent-package work; no operator-package work.
- **Decisions already pinned**: ADR-016 (Lit 4), ADR-019 (`@lit-labs/router`), ADR-017 (RxJS services + signal bridge in components), ADR-018 (`@lit/context` for DI). Custom-element prefix `kea-` is mandatory.
- **Tests required**: component-level unit coverage; integration coverage of deep-link routing; live-update coverage against a fake API stream.

---

## Cross-references

- **Related FDDs**: [0003](0003-crawl-session-management.md), [0004](0004-sitemap-visibility.md), [0005](0005-findings-reporting.md), [0006](0006-live-agent-activity-stream.md), [0007](0007-declarative-crawl-fleets.md)
- **Related ADRs**: [016](../adr/016-lit-web-components.md), [017](../adr/017-rxjs-services-with-signal-bridge.md), [018](../adr/018-lit-context-for-dependency-injection.md), [019](../adr/019-lit-labs-router.md)
