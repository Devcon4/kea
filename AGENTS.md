# AGENTS.md — Kea Quick Context

> Fast-load reference for AI sessions. Do **NOT** expand inline — follow the paths.
> When a task touches a subsystem, read its playbook + the listed key files only.
>
> **Start every session by reading `SKILL.md`** — it covers the dev stack, log paths,
> per-package commands, and what is/isn't possible without docker up.

---

## Identity

Kea is an autonomous chaos-testing tool for web apps. A coordinator agent drives a swarm of specialists (planner in discover/author modes, tester, plus future ones) that crawl a target site through a real headless browser, build a sitemap, and surface findings. The agent runtime is built on the Pi SDK ([ADR-021](docs/adr/021-pi-sdk-as-agent-runtime.md)): the coordinator is a multi-turn `AgentSession` whose tool calls (`navigate`, `discover_features`, `author_plan`, `test`, `revalidate_feature`, `invalidate`, `remove`, `done`) drive the loop, and specialists are Pi sub-agents dispatched by parent tools ([ADR-022](docs/adr/022-pi-subagents-extension-model.md)). The planner specialist runs in two explicit modes: discover and author. A Kubernetes operator manages pools of agent pods against declared targets via CRDs. Local-first: every component runs on a workstation under `docker compose --profile dev`.

## Topology

```
dashboard (Lit, :4200) ─► api (Hono+Drizzle, :4000) ─► postgres (:5432)
                              ▲                              ▲
                              │                              │
                              │ session/sitemap/features/test-plans/scenarios/test-runs/findings │
                              │                              │
                          agent (one-shot crawl) ──► ollama (:11434)
                          ├─ Pi AgentSession (coordinator + planner/tester sub-agents)
                          ├─ Stagehand (Chromium)
                          └─ ApiClient → api  (canonical message log)

operator (Go, kubebuilder) — spawns agent pods via CRDs (chaos.kea.dev/v1alpha1)
seq (:8080)                — structured-log sink
sites/{blog,forms,shop}    — fixture targets to crawl in dev
```

## Packages

| Package | Path | Stack | Purpose |
|---|---|---|---|
| `@kea/shared` | `shared/` | TS, Zod | Domain types, Result, schemas. Pure, no I/O. |
| `@kea/api` | `api/` | Hono, Drizzle, Postgres | Session-scoped REST API; system of record. |
| `@kea/agent` | `agent/` | Node 24, Pi SDK, Stagehand | Multi-agent worker; runs the exploration loop. |
| `@kea/dashboard` | `dashboard/` | Lit 4, Vite, RxJS+signals | SPA showing live session state. |
| operator | `operator/` | Go, controller-runtime | K8s controller for CRDs (`AgentPool`, `TargetResource`, `TestPlan`). |
| sites | `sites/{blog,forms,shop}/` | static / Node | Test-target apps. |

## Tech Constraints

| Concern | Rule |
|---|---|
| TS error model | `Result<T, E>` from `shared/result.ts`; **MUST NOT** throw in business logic |
| TS style | `type` over `interface`; no `else`; ≤ 3 nesting levels; no barrel files; ESM `.js` extensions in imports |
| Logging | `pino` child loggers via `createLogger("module-name")`; SEQ sink in dev |
| Async/state | RxJS `Subject`/`BehaviorSubject` + operators; no manual EventEmitter spaghetti |
| Time | `Temporal.Now.instant()` where supported; fall back to `Date` only when unavoidable |
| Validation | Zod schemas in `@kea/shared`, **MUST** validate at API boundaries |
| Persistence | All durable state in Postgres via `@kea/api`; agent has **no** local DB (ADR-020 supersedes 008) |
| Async/state | Pi `AgentSession` events drive the agent loop; dashboard uses RxJS+signals (ADR-017) |
| Inter-agent comm | Pi sub-agents in-process (ADR-022); A2A is **not** in use — may return only as a cross-pod wire protocol if FDD-0007 demands it |
| LLM client | Pi SDK with a custom OpenAI-compatible provider (ADR-021) against `LLM_BASE_URL`; backend is Ollama (dev) or vLLM (prod) |
| Browser | Stagehand's `act/extract/observe`; **MUST NOT** add a second Playwright instance |
| Container | Non-root, read-only FS, drop ALL caps; writable mounts at `/data`, `/tmp` |
| Dashboard DI | `@lit/context` provider/consumer; services are framework-agnostic classes |

---

## ADR Index

Cross-cutting architectural decisions. When working in a subsystem covered by an ADR, read it before editing. Single global numbering across all packages — see [`docs/adr/README.md`](docs/adr/README.md) for scope semantics.

| ADR | Title | Scope | Status |
|---|---|---|---|
| [001](docs/adr/001-monorepo-structure.md) | Monorepo Structure | project | Accepted |
| [002](docs/adr/002-typescript-agent-runtime.md) | TypeScript for Agent Runtime | agent | Accepted |
| [003](docs/adr/003-go-kubebuilder-operator.md) | Go + Kubebuilder Operator | operator | Accepted |
| [004](docs/adr/004-stagehand-browser-automation.md) | Stagehand for Browser Automation | agent | Accepted |
| [005](docs/adr/005-custom-agent-loop.md) | Custom Agent Loop over Frameworks | agent | Superseded by 021 |
| [006](docs/adr/006-openai-compatible-llm-client.md) | OpenAI-Compatible LLM Client | agent | Superseded by 021 |
| [007](docs/adr/007-a2a-protocol.md) | Google A2A Protocol | agent | Superseded by 022 |
| [008](docs/adr/008-sqlite-persistence.md) | SQLite for Persistence | agent | Superseded by 020 |
| [009](docs/adr/009-result-type-error-handling.md) | Result Type for Error Handling | project | Accepted |
| [010](docs/adr/010-rxjs-reactive-state.md) | RxJS for Reactive State | agent | Superseded by 021 |
| [011](docs/adr/011-hono-http-server.md) | Hono for HTTP Server | agent | Accepted |
| [012](docs/adr/012-container-security.md) | Container Security | agent | Accepted |
| [013](docs/adr/013-coding-standards.md) | TypeScript Coding Standards | project | Accepted |
| [014](docs/adr/014-esbuild-bundler.md) | esbuild for Bundling | agent | Accepted |
| [015](docs/adr/015-ollama-dev-vllm-prod.md) | Ollama Dev / vLLM Prod | agent | Accepted |
| [016](docs/adr/016-lit-web-components.md) | Lit 4 for UI Components | dashboard | Accepted |
| [017](docs/adr/017-rxjs-services-with-signal-bridge.md) | RxJS Services + Signal Bridge | dashboard | Accepted |
| [018](docs/adr/018-lit-context-for-dependency-injection.md) | @lit/context for DI | dashboard | Accepted |
| [019](docs/adr/019-lit-labs-router.md) | @lit-labs/router | dashboard | Accepted |
| [020](docs/adr/020-central-postgresql-api.md) | Central Postgres API (replaces SQLite) | project | Accepted |
| [021](docs/adr/021-pi-sdk-as-agent-runtime.md) | Pi SDK as the Agent Runtime | agent | Accepted |
| [022](docs/adr/022-pi-subagents-extension-model.md) | Pi Sub-Agents as the Specialist Extension Model | agent | Accepted |
| [023](docs/adr/023-pi-session-manager-postgres.md) | Pi Sessions Bridge to the Postgres Message Log | agent | Accepted |
| [024](docs/adr/024-features-as-canonical-spec.md) | Features as the Canonical Test Specification | project | Accepted |

> **Maintenance:** When adding an ADR, append one row here and one row in `docs/adr/README.md`. Numbering is global — pick the next free integer regardless of scope.

---

## FDD Index

Feature Design Documents — PM/UX-style cards describing what each feature *promises* the user. Read the relevant FDD before changing user-visible behavior. For "how it currently works under the hood," read the code and the cited ADRs; FDDs are product intent, not engineering reference. See [`docs/fdd/AGENTS.md`](docs/fdd/AGENTS.md) for the author persona.

| FDD | Title | Scope | Status |
|---|---|---|---|
| [0001](docs/fdd/0001-automated-site-exploration.md) | Automated Site Exploration | agent | Shipped |
| [0002](docs/fdd/0002-pluggable-specialist-agents.md) | Pluggable Specialist Agents | agent | Superseded by 0009 |
| [0003](docs/fdd/0003-crawl-session-management.md) | Crawl Session Management | project | Shipped |
| [0004](docs/fdd/0004-sitemap-visibility.md) | Sitemap Visibility | project | Shipped |
| [0005](docs/fdd/0005-findings-reporting.md) | Findings Reporting | project | Shipped |
| [0006](docs/fdd/0006-live-agent-activity-stream.md) | Live Agent Activity Stream | project | Shipped |
| [0007](docs/fdd/0007-declarative-crawl-fleets.md) | Declarative Crawl Fleets | operator | Accepted |
| [0008](docs/fdd/0008-operator-dashboard.md) | Operator Dashboard | dashboard | Shipped |
| [0009](docs/fdd/0009-pi-extension-specialists.md) | Pi-Extension Specialist Agents | agent | Accepted |
| [0010](docs/fdd/0010-feature-driven-test-planning.md) | Feature-driven Test Planning | project | Accepted |

> **Maintenance:** When changing user-visible behavior of a feature, update its FDD in the same change. When adding a new feature, draft an FDD before implementation. Append one row here and one in `docs/fdd/README.md`.

---

## Pattern Composition

When a task spans multiple subsystems, read the docs in the order shown.

| Task | ADRs (in order) | FDDs |
|---|---|---|
| New Pi specialist (e.g. `summarizer`) | [022](docs/adr/022-pi-subagents-extension-model.md) → [021](docs/adr/021-pi-sdk-as-agent-runtime.md) → [023](docs/adr/023-pi-session-manager-postgres.md) → [024](docs/adr/024-features-as-canonical-spec.md) → [009](docs/adr/009-result-type-error-handling.md) | [0009](docs/fdd/0009-pi-extension-specialists.md) → [0010](docs/fdd/0010-feature-driven-test-planning.md) → [0001](docs/fdd/0001-automated-site-exploration.md) |
| New API route on a session | [020](docs/adr/020-central-postgresql-api.md) → [011](docs/adr/011-hono-http-server.md) → [009](docs/adr/009-result-type-error-handling.md) | [0003](docs/fdd/0003-crawl-session-management.md) |
| New persisted entity (table) | [020](docs/adr/020-central-postgresql-api.md) | [0003](docs/fdd/0003-crawl-session-management.md) — confirm cascade rules |
| New dashboard view | [019](docs/adr/019-lit-labs-router.md) → [016](docs/adr/016-lit-web-components.md) → [017](docs/adr/017-rxjs-services-with-signal-bridge.md) → [018](docs/adr/018-lit-context-for-dependency-injection.md) | [0008](docs/fdd/0008-operator-dashboard.md) |
| New shared type or schema | [013](docs/adr/013-coding-standards.md) → [009](docs/adr/009-result-type-error-handling.md) | — |
| New CRD or operator behavior | [003](docs/adr/003-go-kubebuilder-operator.md) → [012](docs/adr/012-container-security.md) | [0007](docs/fdd/0007-declarative-crawl-fleets.md) |
| Change to LLM backend / model | [015](docs/adr/015-ollama-dev-vllm-prod.md) → [021](docs/adr/021-pi-sdk-as-agent-runtime.md) | [0001](docs/fdd/0001-automated-site-exploration.md) — fallback path |
| Change to browser automation | [004](docs/adr/004-stagehand-browser-automation.md) → [012](docs/adr/012-container-security.md) | [0001](docs/fdd/0001-automated-site-exploration.md) |

> **Maintenance:** Curated, not mechanical. A new ADR doesn't always mean a new row — it may extend an existing chain.

---

## Key Design Decisions (gotchas)

- **Postgres is the only durable store.** Agent has no local SQLite. ADR-008 was superseded by ADR-020. `@kea/agent` talks to `@kea/api` over HTTP via `ApiClient`. Don't reintroduce `better-sqlite3`.
- **The agent loop is a Pi `AgentSession`.** Coordinator emits tool calls (`navigate | discover_features | author_plan | test | revalidate_feature | invalidate | remove | done`); the loop dispatches them. Specialists are Pi sub-agents created by parent tools (ADR-022). A2A is no longer in use in-process — don't reintroduce `agent/src/a2a/`.
- **Pi sessions are in-memory; Postgres is the canonical message log.** Pi events bridge into `addMessage()` so the live and historical streams share one source (ADR-023, FDD-0006). Don't add a second message store.
- **Sessions are the aggregate root.** Sitemap, findings, and chat messages all FK to `sessions(id)` with `ON DELETE CASCADE`. Deleting a session deletes everything. Domain logic for the aggregate lives in `api/src/session/domain.ts` — routes call domain functions, never mutate directly.
- **Scenario-linked findings preserve history truthfully.** Findings emitted by the tester are anchored to a scenario; severity is derived from run outcome, not LLM invention (FDD-0010 / ADR-024). Findings outlive scenario deletes via FK set-null.
- **Page status only advances.** Transitions: `discovered` → `visited` → `tested`. `upsertPage` **MUST NOT** downgrade. `invalidatePage` is the only legal way back to `discovered`.
- **URL normalization happens once, in `@kea/shared/normalizeUrl`.** Strip default ports, default empty path to `/`. Always call before storing or comparing URLs.
- **Coordinator drives the loop with tool calls, not JSON output.** Eight tools: `navigate | discover_features | author_plan | test | revalidate_feature | invalidate | remove | done`. The Pi runtime dispatches them. If the LLM emits no tool call within budget (or calls `done` while work remains), the lifecycle interceptor synthesizes a fallback plan via `buildFallbackPlan` (FDD-0001 reliability NFR).
- **The browser is single-instance and sequential.** Stagehand owns one Chromium; the coordinator's `navigate` and `test` tools share it. Don't try to parallelize without giving each its own Stagehand context.
- **404 / redirect detection lives in `executeNavigate`.** A redirected URL is *removed* (not visited); a 404 page is also removed. These are the only two non-status mutations during navigation.
- **Dashboard services are pure RxJS classes.** They **MUST NOT** import `lit`. `toSignal()` lives only in components, via `rxjs-interop.ts`.
- **The dashboard `kea-` prefix is mandatory.** Every custom element is `kea-*`. Don't ship a bare-name element.
- **Container is read-only.** Anything that writes must target `/data` (sqlite was here, now obsolete) or `/tmp` (Playwright profiles, downloads). Don't write to cwd.
- **`LLM_BASE_URL` switches the backend.** Pi's custom-provider hook registers the OpenAI-compatible endpoint (ADR-021); same env contract works for Ollama, vLLM, and any compatible cloud provider. No code change needed to swap.
- **Operator and agent are independently deployable.** Don't add tight coupling — they communicate through CRDs (operator → agent pod env) and via the central API (agent → state).
