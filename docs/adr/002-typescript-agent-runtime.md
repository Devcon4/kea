# ADR-002: TypeScript for Agent Runtime

**Status**: Accepted

## Context

The agent worker drives a headless browser, orchestrates LLM calls, and manages a multi-agent chatroom. We needed to choose a runtime language.

## Decision

Use TypeScript on Node.js 22 with ESM modules. Target ES2024 with strict mode enabled.

## Alternatives Considered

- **Python**: Strong LLM ecosystem (LangChain, CrewAI), but browser automation libraries are weaker. Stagehand (our chosen browser tool) is TypeScript-native. Python's async model is less natural for long-running browser sessions with concurrent agent loops.
- **Go**: Would unify the stack with the operator, but Go lacks mature browser automation libraries. The LLM tool-calling ecosystem is nascent in Go.
- **Deno**: Considered but rejected due to smaller ecosystem and potential compatibility issues with npm packages like Stagehand and better-sqlite3 (native addon).
- **Bun**: Explicitly excluded per team preference. Native addon support (better-sqlite3) is less mature.

## Consequences

- Full access to the JavaScript browser automation ecosystem (Playwright, Stagehand).
- OpenAI npm package provides first-class TypeScript types for LLM interactions.
- Native addons (better-sqlite3) work reliably on Node.js.
- Type safety catches protocol mismatches at compile time (A2A types, tool definitions).
- Node.js 22 provides modern APIs (structuredClone, Temporal coming, native fetch).
