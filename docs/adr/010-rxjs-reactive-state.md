# ADR-010: RxJS for Reactive State Management

**Status**: Accepted

## Context

Kea's agent loop involves multiple concurrent concerns: task state changes, LLM response streams, browser events, and inter-agent messages. We needed a state management approach that handles event-driven flows without deeply nested callbacks or mutable state.

## Decision

Use RxJS for reactive state management throughout the agent worker:

- `BehaviorSubject` for stateful collections (task maps, agent registries).
- `Subject` for event streams (task lifecycle events, agent messages).
- Observable pipelines with operators (`filter`, `map`, `scan`, `switchMap`) for composing async flows.
- Prefer reactive pipelines over mutable primitives and imperative state updates.

## Alternatives Considered

- **Signals (TC39 proposal / @preact/signals)**: Simpler reactive primitive, but designed for UI rendering. Lacks operators for complex async composition (debounce, switchMap, merge). Not suited for streaming/event-heavy server workloads.
- **Plain EventEmitter**: Node.js native. No backpressure, no composition operators, no typed event streams. Leads to callback spaghetti with many interacting event sources.
- **Redux/Zustand**: State management libraries designed for UI. Overkill for server-side state, wrong abstraction level.
- **Imperative Maps + callbacks**: Our first implementation. Worked but made it difficult to observe state changes across modules. Adding a "notify on task completion" feature required manual wiring everywhere.

## Consequences

- Task state is observable — any module can subscribe to `tasksByState$("TASK_STATE_COMPLETED")` without coupling to the task store implementation.
- The A2A server exposes `taskEvents$` as an Observable, enabling reactive composition in the exploration loop.
- `BehaviorSubject` provides both current-value access (`.getValue()`) and change notification (`.subscribe()`).
- RxJS is a well-maintained, battle-tested library with excellent TypeScript types.
- Learning curve for developers unfamiliar with reactive programming. Mitigated by using simple patterns (Subject + filter/map) rather than complex marble-diagram operators.
- Must call `dispose()` to complete subjects and prevent memory leaks.
