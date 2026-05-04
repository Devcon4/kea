# Architecture Decision Records

Each record captures a significant architectural or technology decision, its context, and the rationale. ADRs are immutable once accepted — they document the decision as it was made. When a decision changes, write a new ADR and mark the old one **Superseded**.

For *product intent* — what each feature promises and how we know it's done — see [`../fdd/`](../fdd/). For *current implementation details*, read the code and the cited ADRs.

## Scope

Each ADR has a `Scope:` field naming where it applies. ADRs share a single global numbering namespace.

| Scope | Meaning |
|---|---|
| `project` | Cross-cutting; affects two or more packages |
| `agent` | `@kea/agent` only |
| `api` | `@kea/api` only |
| `dashboard` | `@kea/dashboard` only |
| `operator` | Go operator only |
| `shared` | `@kea/shared` only |

## Index

| ADR | Title | Scope | Status |
|---|---|---|---|
| [001](001-monorepo-structure.md) | Monorepo Structure | project | Accepted |
| [002](002-typescript-agent-runtime.md) | TypeScript for Agent Runtime | agent | Accepted |
| [003](003-go-kubebuilder-operator.md) | Go + Kubebuilder for K8s Operator | operator | Accepted |
| [004](004-stagehand-browser-automation.md) | Stagehand for Browser Automation | agent | Accepted |
| [005](005-custom-agent-loop.md) | Custom Agent Loop over Frameworks | agent | Superseded by [021](021-pi-sdk-as-agent-runtime.md) |
| [006](006-openai-compatible-llm-client.md) | OpenAI-Compatible LLM Client | agent | Superseded by [021](021-pi-sdk-as-agent-runtime.md) |
| [007](007-a2a-protocol.md) | Google A2A Protocol for Agent Communication | agent | Superseded by [022](022-pi-subagents-extension-model.md) |
| [008](008-sqlite-persistence.md) | SQLite for Persistence | agent | Superseded by [020](020-central-postgresql-api.md) |
| [009](009-result-type-error-handling.md) | Result Type for Error Handling | project | Accepted |
| [010](010-rxjs-reactive-state.md) | RxJS for Reactive State Management | agent | Superseded by [021](021-pi-sdk-as-agent-runtime.md) |
| [011](011-hono-http-server.md) | Hono for HTTP Server | agent | Accepted |
| [012](012-container-security.md) | Container Security (Non-Root, ReadonlyFS) | agent | Accepted |
| [013](013-coding-standards.md) | TypeScript Coding Standards | project | Accepted |
| [014](014-esbuild-bundler.md) | esbuild for Bundling | agent | Accepted |
| [015](015-ollama-dev-vllm-prod.md) | Ollama for Dev, vLLM for Production | agent | Accepted |
| [016](016-lit-web-components.md) | Lit 4 for UI Components | dashboard | Accepted |
| [017](017-rxjs-services-with-signal-bridge.md) | RxJS Services with Signal Bridge | dashboard | Accepted |
| [018](018-lit-context-for-dependency-injection.md) | @lit/context for DI | dashboard | Accepted |
| [019](019-lit-labs-router.md) | @lit-labs/router for Client-Side Routing | dashboard | Accepted |
| [020](020-central-postgresql-api.md) | Central PostgreSQL API replacing SQLite | project | Accepted |
| [021](021-pi-sdk-as-agent-runtime.md) | Pi SDK as the Agent Runtime | agent | Accepted |
| [022](022-pi-subagents-extension-model.md) | Pi Sub-Agents as the Specialist Extension Model | agent | Accepted |
| [023](023-pi-session-manager-postgres.md) | Pi Sessions Bridge to the Postgres Message Log | agent | Accepted |

> **Maintenance:** When adding an ADR, append one row here. Use the next free number across the whole table — do not start a new sequence per scope. New ADR also auto-rows in the root `AGENTS.md` index.

## Template

See [template.md](template.md).
