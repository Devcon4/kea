# ADR-002: RxJS Services with Signal Bridge for State Management

**Status:** Accepted  
**Date:** 2026-04-12

## Context

We need a state management pattern for the dashboard. The team has strong RxJS experience from Angular and the agent already uses RxJS. Lit 4 introduces experimental signal support via `@lit-labs/signals` (TC39 Signals Proposal polyfill).

## Decision

Use a **hybrid approach**:

1. **Application state** lives in RxJS-based services using `BehaviorSubject` — fetch from API, cache, transform, combine.
2. **Presentation state** in components uses signals created via a `toSignal()` bridge — components derive render-ready signals from service observables.
3. A small `rxjs-interop` module provides `toSignal(observable, initialValue)` and `toObservable(signal)`, modeled after Angular's `@angular/core/rxjs-interop`.

## Rationale

- **RxJS for async/API:** RxJS excels at HTTP request orchestration, retry logic, combining streams, and caching. BehaviorSubject gives synchronous `.value` access plus reactive subscriptions.
- **Signals for rendering:** Lit's `SignalWatcher` mixin auto-tracks signal reads in `render()`, eliminating manual subscription lifecycle. No `takeUntil($destroy)` boilerplate.
- **Familiar pattern:** This mirrors Angular 17+'s recommended approach — services own Observables, components consume via `toSignal()`.
- **Clean separation:** Services are framework-agnostic (pure RxJS). Only the thin bridge layer couples to Lit's signal system.

## Alternatives Considered

- **Pure RxJS + custom `@async` decorator** — Works but requires manual `disconnectedCallback` cleanup and a custom decorator. More boilerplate.
- **Pure signals everywhere** — Signals lack RxJS's operator ecosystem for complex async flows (retry, debounce, switchMap, combineLatest).
- **Redux/MobX** — External state libraries add weight and unfamiliar APIs.

## Consequences

- `@lit-labs/signals` is still in labs — API may change. The bridge module isolates this risk.
- `signal-utils` provides `SignalArray`, `SignalMap`, and `@signal` decorator for richer signal data structures.
- Subscriptions created by `toSignal()` must be cleaned up on component disconnect — the bridge handles this via `SignalWatcher`.
