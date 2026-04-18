# ADR-005: Custom Agent Loop over Frameworks

**Status**: Accepted

## Context

Multi-agent orchestration frameworks (Mastra, LangGraph, CrewAI, AutoGen) provide abstractions for agent communication, tool routing, and state management. We needed to decide whether to adopt one.

## Decision

Build a custom agent loop with no framework dependency. Each agent is defined by a system prompt, a set of allowed tools, and an A2A Agent Card. A coordinator agent examines the current exploration state and delegates to specialist agents (navigator, tester).

## Alternatives Considered

- **Mastra**: TypeScript-native, good A2A support. Rejected because it adds a large dependency surface for orchestration logic we can implement in ~200 lines. The custom approach keeps the agent loop transparent and debuggable.
- **LangGraph (LangChain)**: Python-centric. JS port exists but is less mature. Heavy abstraction layer for what is fundamentally a loop: observe → decide → act → store.
- **CrewAI**: Python-only. Role-based agent pattern is appealing but the framework is opinionated about execution flow.
- **AutoGen**: Microsoft's multi-agent framework. Python-first, complex conversation patterns. Overkill for our use case.

## Consequences

- Full control over the agent loop — easy to add custom logic (rate limiting, backoff, budget tracking).
- No framework version upgrades to manage or breaking changes to adapt to.
- Agent communication uses the A2A protocol (ADR-007), which is framework-agnostic.
- We must implement our own tool dispatch, message history management, and turn-taking. This is handled via RxJS reactive pipelines (ADR-010).
- Switching LLM backends is just a URL change since we use the OpenAI-compatible API (ADR-006).
- If a framework matures and provides clear value, migration is straightforward since our agents are simple function-based handlers.
