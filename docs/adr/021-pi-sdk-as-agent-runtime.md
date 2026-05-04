# ADR-021: Pi SDK as the Agent Runtime

**Status**: Accepted
**Scope**: agent

## Context

The original agent runtime (ADR-005, ADR-006) was a hand-rolled loop on top of the `openai` SDK: one chat call per planning batch, JSON-emitting prompts, regex extraction, deterministic fallback in code. It predates the surrounding ecosystem. It also locks Kea out of features that were not available when ADR-005 landed: prompt caching, multi-turn tool calling, sub-agent orchestration, compaction, session branching, structured event streams, lifecycle hooks, token/cost accounting.

The Oh My Pi harness the team already runs on is built on `@mariozechner/pi-coding-agent`. Adopting the same runtime here gives Kea those features for free, brings the `@kea/agent` mental model in line with how the team already thinks about agent loops, and lets us delete a non-trivial amount of glue (hand-rolled chat client, JSON parsing, fallback wiring, tool-result plumbing) that has no Kea-specific value.

The architectural pivot is committed at the product/engineering level: Kea's agent becomes a **multi-turn LLM loop driven by Pi sessions**, with **LLM-driven tool calls** for `navigate`, `test`, `invalidate`, `remove`, and `done`. A 1:1 swap of the LLM client for Pi's `chat` primitive is explicitly **not** the goal — it would pay full migration cost for a sliver of Pi's value.

## Decision

Use `@mariozechner/pi-coding-agent` as the agent runtime for `@kea/agent`. Specifically:

- Each Kea agent (coordinator, tester) is an `AgentSession` created with `createAgentSession()`.
- Tool schemas are TypeBox; the LLM picks the next action turn-by-turn.
- The OpenAI-compatible LLM endpoint (Ollama in dev, vLLM in production — ADR-015) is wired through Pi's `registerProvider()` API as a custom provider with `api: "openai-completions"`. The `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` env contract from ADR-006 is preserved at the surface but its implementation is now Pi.
- Prompt caching, compaction, session branching, retries, and token/cost accounting come from Pi defaults; we do not reimplement them.
- The deterministic fallback path required by FDD-0001 (planner produces nothing usable → keep the crawl moving) survives as a **Pi `tool_call` lifecycle interceptor** that synthesizes a fallback plan when the LLM emits no tool call within budget. The `buildFallbackPlan` rule (1 navigate from unvisited + up to 3 tests from untested + done if both empty) is preserved as a pure function called by that interceptor.

This ADR supersedes both [ADR-005](005-custom-agent-loop.md) (custom loop) and [ADR-006](006-openai-compatible-llm-client.md) (raw `openai` SDK). The *intent* of ADR-006 — LLM backend portability via the OpenAI-compatible API — is preserved; only the implementation changes.

## Alternatives Considered

- **Keep the custom loop, adopt only Pi's `chat` primitive.** Rejected: pays the full migration cost for ≈10% of Pi's value. Compaction, prompt caching, sub-agents, lifecycle hooks, sessions — all the parts that justify the pivot — sit one layer above `chat`. This option is the worst of both worlds.
- **Adopt a different agent framework (Mastra / Vercel AI SDK / LangGraph-JS).** Rejected: the team already runs on Pi via Oh My Pi. Picking a different runtime means two mental models in the same head, two upgrade cadences, and zero ecosystem reuse. The single-maintainer concern is named below as a real risk; we accept it deliberately rather than diluting the team's runtime knowledge.
- **Stay on the custom loop, extend it ourselves.** Rejected: every feature we'd add (compaction, caching, sub-agents) is one we'd write and maintain at agent-runtime quality. That's not the Kea team's value-add; chaos testing of web apps is.
- **RPC to a separate `pi` subprocess (pi-rpc mode).** Rejected: process isolation buys us nothing inside the agent pod (which is already its own process boundary), and we lose direct access to the agent state we need for the live message stream (FDD-0006).

## Consequences

- The hand-rolled `chat()` client and JSON-parsing helpers are deleted; their absence is the most visible win.
- Coordinator and tester each become a multi-turn LLM loop instead of a single round-trip. The cost shape changes: today's "one planner call per batch" NFR in [FDD-0001](../fdd/0001-automated-site-exploration.md) is incompatible with multi-turn tool use and is rewritten in that FDD to express the real intent (bounded LLM calls per crawl, prompt caching where the provider exposes it, a per-session token budget).
- `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` continue to control which backend Kea talks to. Switching Ollama → vLLM → cloud provider remains an env-var change.
- Pi's filesystem-based extension discovery (`~/.config/pi/extensions/`) is **not** used. Extensions are baked at build time and passed explicitly via `ResourceLoader`. This preserves [ADR-012](012-container-security.md) (read-only filesystem; no operator-installed runtime extensions).
- Pi's default JSONL-on-disk session storage is **not** used. Postgres remains the system of record per [ADR-020](020-central-postgresql-api.md); the bridging mechanism is described in [ADR-023](023-pi-session-manager-postgres.md).
- Test surface changes. The previous `chat()`-mock pattern is gone; tests now run against a fake Pi provider plus a fake `ResourceLoader`. A small test harness lives alongside the runtime scaffold.
- Single-maintainer ecosystem risk for `@mariozechner/*`. Mitigated by: Oh My Pi already shares this dependency; source is open (`pi-mono`); fork is feasible if the project goes silent. Acceptable because the alternative (different framework) costs more team-cognitive bandwidth than this risk costs.
- Local-model tool-use quality is a real risk. Validated during migration Phase 0: `gemma4:e4b` on Ollama emits correct multi-turn tool calls via `openai-completions` with well-engineered prompts. Prompt rigor becomes part of the engineering cost the coordinator/tester rewrites must absorb.
