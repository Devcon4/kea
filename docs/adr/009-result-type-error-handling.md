# ADR-009: Result Type for Error Handling

**Status**: Accepted

## Context

TypeScript's default error handling uses thrown exceptions, which are invisible in type signatures. For an agent system where failures are expected (LLM timeouts, browser crashes, network errors), we need explicit error handling that makes failure paths visible.

## Decision

Use a discriminated union `Result<T, E>` type for all fallible operations. Business logic never throws — errors are returned as values.

```typescript
type Result<T, E = Error> = Ok<T> | Err<E>;
type Ok<T> = { readonly ok: true; readonly value: T };
type Err<E> = { readonly ok: false; readonly error: E };
```

Helper functions:
- `Ok(value)` / `Err(error)` — constructors
- `isOk()` / `isErr()` — type guards
- `tryCatch()` / `tryCatchSync()` — wrap throwing code at system boundaries
- `mapResult()` — transform success values
- `unwrap()` — extract value or throw (for tests only)

## Alternatives Considered

- **neverthrow**: Popular Result library for TypeScript. Rejected to avoid the dependency — our Result type is ~60 lines and covers all our use cases. neverthrow's Railway-oriented chaining is nice but adds API surface we don't need.
- **fp-ts Either**: Full functional programming toolkit. Massive API surface, steep learning curve, heavy bundle size. We want Go-style simplicity, not Haskell.
- **Thrown exceptions with try/catch**: TypeScript's native approach. Rejected because catch blocks lose type information — you can't know what error types a function might throw without reading its implementation.
- **Tuple returns `[value, error]`**: Go-style. Works but loses the discriminated union benefit — TypeScript can't narrow the types via `result.ok`.

## Consequences

- Every function signature communicates whether it can fail and what error type it produces.
- Pattern matching with `if (!result.ok) return result` enables clean early-return error propagation.
- `tryCatch` / `tryCatchSync` are used at system boundaries (database calls, network requests, JSON parsing) to convert thrown exceptions into Result values.
- No try/catch blocks scattered through business logic.
- Slightly more verbose than bare throws, but the explicitness prevents silent failures in agent pipelines.
