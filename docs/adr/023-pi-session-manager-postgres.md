# ADR-023: Pi Sessions Bridge to the Postgres Message Log

**Status**: Accepted
**Scope**: agent

## Context

[ADR-020](020-central-postgresql-api.md) makes Postgres the system of record for sessions, sitemap, findings, and the agent message log; `@kea/agent` writes through `@kea/api` and holds no durable state of its own. [FDD-0006](../fdd/0006-live-agent-activity-stream.md) makes the Postgres message log the canonical surface the dashboard streams from — every visible agent decision and its associated thinking lands there in order, and a worker restart **MUST NOT** lose or duplicate messages already persisted.

Pi (adopted in [ADR-021](021-pi-sdk-as-agent-runtime.md)) ships its own session storage: each `AgentSession` is backed by a `SessionManager` that, in default form, persists to a JSONL file under `~/.pi/agent/sessions/`. Pi's session tree carries everything we'd otherwise reconstruct (user/assistant messages, tool calls, tool results, thinking, model changes, compaction summaries, branches), but it does so on the local filesystem of the agent pod — which, per [ADR-012](012-container-security.md), is read-only, with `/data` and `/tmp` as the only writable mounts.

Two questions follow:

1. Where does Pi's session live?
2. How does FDD-0006's promise — every visible decision in Postgres, in order, no live/historical drift — survive when the agent loop is now a Pi session?

## Decision

**Postgres remains the canonical message log. Pi's session is in-memory only and bridges into Postgres via event subscription.**

Concretely:

- Each `AgentSession` is created with `SessionManager.inMemory()`. No JSONL files are written; no filesystem writes outside `/tmp` happen for session bookkeeping.
- A bridge subscribes to the session's event stream (`session.subscribe(...)`) and translates Pi events into `addMessage(...)` writes against `@kea/api`. The mapping is: assistant `text_delta`/`thinking_delta` accumulate into one message per assistant turn; `tool_execution_start` / `tool_execution_end` produce a structured message attributed to the agent that issued the call; the message's `agentId` is the role (coordinator / tester / specialist-name) the bridge knows from the session it's attached to.
- The agent **MUST NOT** rely on Pi's in-memory tree for any read consumed by the dashboard or by another worker. Postgres is the only place anyone reads the message log from.
- A worker restart loses Pi's in-memory tree by design. Already-persisted Postgres rows are unaffected; the new worker starts a fresh Pi session and resumes writing forward. This satisfies the FDD-0006 acceptance criterion that "messages already persisted remain queryable" without trying to mirror Pi's tree across pod restarts.

This ADR does not subclass `SessionManager`. The custom-`SessionManager`-as-Postgres-adapter approach was considered first; the in-memory-plus-event-bridge approach is simpler, has a smaller blast radius, and matches what FDD-0006 actually needs (a write-through log keyed to agent decisions, not a faithful replica of Pi's tree).

## Alternatives Considered

- **Subclass / reimplement `SessionManager` against Postgres.** Rejected. Pi's `SessionManager` API is broad (tree navigation, branching, labels, compaction summaries, JSONL invariants); reimplementing it faithfully against Postgres would be a project of its own, and our consumer (the dashboard) doesn't care about most of it. The simpler bridge covers FDD-0006's promise and ignores the rest, which is the right boundary.
- **Use `SessionManager.create(cwd)` with a writable scratch dir under `/tmp`.** Rejected. Pi files would be junk-on-disk that nothing reads — dead code in disk form. Postgres is already the canonical log; writing to a second store invites the live-vs-historical drift FDD-0006 explicitly forbids ("no live-only or historical-only messages").
- **Bridge from inside a Pi extension.** Considered. Cleanly co-locates the bridge with Pi's lifecycle. Rejected for now: extensions are designed for portable behavior, but this bridge is bound to Kea's `ApiClient` and `addMessage` shape. Keeping the bridge in `@kea/agent` next to the session factory keeps its dependency graph honest. If the bridge stabilizes and grows reuse, extracting it later is a small refactor.

## Consequences

- One write path for the message log: every Pi event the bridge cares about translates to one `addMessage` call, and that call is the only thing the dashboard or any historical consumer reads. Live and historical surfaces share a single source. FDD-0006's truthfulness criterion is satisfied by construction.
- The bridge is the only place that knows how to map "Pi event" to "Kea message." If Pi adds a new event type we want to surface (compaction summary, branch summary, retry start), the bridge is the one place to extend.
- Pi's sub-agent / branching features still work — a child session created by a tool gets its own in-memory `SessionManager` and its own bridge instance attached at the same `agentId`, so nested specialist work appears in the message log under its own attribution.
- Worker restarts intentionally drop Pi's in-flight tree. There is no resume-from-mid-turn mechanism; a restart looks like an interrupted prompt, and the next coordinator iteration plans from the current Postgres-stored sitemap state. This is consistent with FDD-0001's "the crawl falls back to a deterministic next step" reliability stance.
- We ignore Pi's compaction/branch features as user-facing concerns. They still operate inside the in-memory session (and reduce token cost), but their summaries are not exposed through the dashboard message log unless the bridge is extended to surface them.
- The event-stream contract from Pi (`message_update`, `tool_execution_*`, `agent_*`, `turn_*`) becomes part of the integration surface. If Pi changes those event names in a major version, the bridge breaks loudly — preferable to a silent drop.
