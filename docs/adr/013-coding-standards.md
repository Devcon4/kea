# ADR-013: TypeScript Coding Standards

**Status**: Accepted

## Context

Consistent coding standards reduce cognitive load and prevent common bugs. Kea's agent worker is TypeScript-heavy, and we needed to document the conventions that all code follows.

## Decision

The following standards are enforced across all TypeScript code (see `.instructions.md` for the full specification):

### Type System
- `type` over `interface` — always. Interfaces are never used.
- Strict mode (`strict: true` in tsconfig). No `any` — use `unknown` + type guards.
- Complex type helpers (mapped, conditional, template literals) are encouraged for compile-time safety.
- Branded types for domain identifiers (URLs, IDs).

### Error Handling
- `Result<T, E>` for all fallible operations. Business logic never throws.
- `tryCatch` / `tryCatchSync` at system boundaries only.
- Early return on error: `if (!result.ok) return result`.

### Control Flow
- Early returns only. Maximum 3 levels of nesting.
- No `else` or `else if` blocks — use early returns or ternaries.
- Guard clauses at function entry.

### Code Organization
- No barrel files (`index.ts` re-exports). Direct imports always.
- Functional patterns preferred. Minimize classes (use for stateful services only).
- Go-style simplicity — smallest possible API surface.

### Tooling
- Prettier for formatting (double quotes, semicolons, 2-space indent, trailing commas).
- pino for structured JSON logging.
- Vitest for testing (colocated test files).
- Temporal API over `Date` (when available).

### Reactive Patterns
- RxJS for state management (Subject, BehaviorSubject, operators).
- Prefer reactive pipelines over mutable state.

## Alternatives Considered

- **ESLint-enforced rules**: Would provide automated enforcement but adds tooling complexity. The team is small enough that code review + documented standards suffice. ESLint can be added later.
- **Biome**: Considered as a Prettier + ESLint replacement. Good performance but less ecosystem support for custom rules. Sticking with Prettier for now.

## Consequences

- Code is consistent across all modules — any file reads the same.
- No ambiguity about style choices (type vs interface, error handling, imports).
- The `no else` rule forces early returns, producing flatter, more readable functions.
- Result types add verbosity but make error paths explicit in function signatures.
- New contributors must read `.instructions.md` before contributing — standards are non-obvious (e.g., no else blocks is unusual).
