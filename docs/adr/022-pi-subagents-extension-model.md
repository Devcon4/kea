# ADR-022: Pi Sub-Agents as the Specialist Extension Model

**Status**: Accepted
**Scope**: agent

## Context

[ADR-007](007-a2a-protocol.md) adopted the Google A2A v1.0 protocol as Kea's inter-agent communication mechanism. In practice, A2A has only ever been used **inside a single agent process** at a `local://` HTTP transport: the coordinator, navigator, and tester are three `A2AServer` instances inside the same Node process, talking to each other through an in-memory dispatch path that imitates HTTP. There is no cross-process A2A traffic in the deployed system today.

The Pi runtime adopted in [ADR-021](021-pi-sdk-as-agent-runtime.md) provides a native delegation pattern: a tool exposed on the parent session creates a child `AgentSession` to perform a focused task and returns a structured result. Pi's SDK calls this out explicitly as a use case ("Build custom tools that spawn sub-agents") — the parent's tool implementation calls `createAgentSession()` again, runs the child to a tool-call terminal, and returns the child's output as the parent tool's result.

With Pi owning delegation, two extension models would coexist in the same package: A2A for "in-process specialists" and Pi sub-agents for everything Pi natively supports. That's exactly the design-integrity failure the team would reject in any other change — two parallel "how do you add a capability" stories, neither covering its domain completely.

## Decision

**Pi sub-agents are the canonical extension model for Kea specialists.** A new specialist (accessibility auditor, visual-diff agent, content summarizer) is added by:

1. Defining a TypeBox parameter schema and a `defineTool()` whose `execute` creates and runs a child `AgentSession` configured for the specialist's job.
2. Registering that tool on the coordinator session (or on whatever parent should be able to dispatch the specialist).
3. Letting Pi's session lifecycle handle isolation, retries, token accounting, and event streaming.

A2A as an in-process delegation mechanism is **dropped**. The `@kea/agent` source no longer carries an A2A server, A2A client, A2A types, or `local://` transport. Existing specialists (coordinator, tester) are rewritten as Pi sessions; the navigator (today an A2A peer) becomes a tool implementation behind the coordinator's `navigate` tool.

A2A may return later as a **wire protocol** for genuinely cross-pod agent-to-agent communication if [FDD-0007](../fdd/0007-declarative-crawl-fleets.md) (declarative crawl fleets) grows a need for cross-cluster agent talk. That use case is out of scope for this ADR; this ADR only addresses extension within a single agent process.

This ADR supersedes [ADR-007](007-a2a-protocol.md). [FDD-0002](../fdd/0002-pluggable-specialist-agents.md) is rewritten as [FDD-0009](../fdd/0009-pi-extension-specialists.md) — the product promise (extensible specialist agents) is preserved; only the implementation contract changes.

## Alternatives Considered

- **Keep A2A in-process alongside Pi sub-agents.** Rejected: two parallel extension stories, neither earning its keep. Every contributor would have to learn both, and every specialist author would have to choose between them with no defensible criterion. This is the design-integrity failure named in `code-integrity` — "one concept, one representation."
- **Keep A2A and avoid Pi sub-agents.** Rejected: forfeits the lifecycle isolation, token accounting, and event surface Pi already gives us. We'd have to rebuild those on top of A2A — a project larger than the migration itself.
- **Keep A2A as a cross-pod wire protocol *now*, alongside Pi sub-agents in-process.** Rejected as premature: today there is zero cross-pod agent traffic. Carrying the A2A code "in case" violates "delete on the way in." If FDD-0007 grows that need, we restore A2A from git history at that point — a clean revert is cheaper than maintaining a feature with no current consumer.
- **Adopt MCP (Model Context Protocol) for specialist delegation.** Rejected: MCP serves tools and context to a single LLM, not delegated task execution between peer agents. It answers a different question.

## Consequences

- A new specialist is one TypeScript file: a TypeBox schema, a system prompt, a `defineTool` whose `execute` creates a child `AgentSession`. No protocol primitives, no Agent Cards, no task-state tables.
- Specialist failures isolate naturally: a child session that throws or hits its budget surfaces as an `isError: true` tool result; the parent decides what to do, and sibling specialists are unaffected. This satisfies the FDD-0009 isolation criterion.
- Specialists are discoverable to the parent via the parent's tool list — the same surface the LLM already sees. We lose A2A's machine-readable Agent Card *as a discovery surface*, but we never used it for discovery in practice (it was a static published descriptor for an in-process call).
- The exploration loop is simpler: one Pi session is the orchestrator; tools dispatch to children; the loop's job collapses to "drive the coordinator session and translate its tool calls into browser/store actions."
- Dropping A2A removes ≈3 files (`a2a/server.ts`, `a2a/client.ts`, `a2a/types.ts` plus specs). Their absence is part of the migration's correctness — the README-style "we use A2A" claim becomes false on commit and the source has to match.
- The interop affordance ADR-007 cited ("any A2A-compliant client can call a Kea specialist") is forfeited. This was speculative and never exercised; if a future FDD requires it, A2A returns as a *wire* protocol with explicit cross-pod scope, not as an in-process imitation of one.
- Settings/extensions discovery via filesystem (`~/.config/pi/extensions/`) remains disabled per [ADR-012](012-container-security.md); specialists are compiled in.
