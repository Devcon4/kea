# ADR-003: @lit/context for Dependency Injection

**Status:** Accepted  
**Date:** 2026-04-12

## Context

Services (e.g., `SessionService`) need to be shared across the component tree. We need a DI/IoC mechanism that supports:

- Singleton services shared across the app
- Testability — swap service instances in tests
- No global mutable state

## Decision

Use **`@lit/context`** for dependency injection across the component tree.

## Rationale

- **Official Lit package** — stable, maintained, designed for custom elements.
- **Hierarchical scoping** — mirrors Angular's injector tree. A parent `@provide()`s, descendants `@consume()`. Different subtrees can have different instances.
- **Decorator API** — `@provide({ context: key })` and `@consume({ context: key })` are clean and declarative.
- **Testable** — wrap a component in a test host that provides mock services.
- **Standards-based** — uses the W3C Context Community Protocol, interoperable with other web component libraries.

## Alternatives Considered

- **Global singleton registry** — Simple `Map<Token, Instance>` container. Works but loses hierarchical scoping and test isolation without manual cleanup.
- **Constructor injection** — Verbose, requires factories, doesn't align with declarative custom element registration.
- **InversifyJS** — Full IoC container, too heavy for a Lit SPA. Designed for Node.js/class-heavy architectures.

## Consequences

- The app shell element must `@provide()` all root-level services.
- Context keys are defined in a shared `contexts.ts` module.
- Services are plain classes — not coupled to Lit or the DOM. Only the wiring layer uses `@provide`/`@consume`.
