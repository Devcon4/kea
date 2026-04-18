# ADR-001: Lit 4 for UI Components

**Status:** Accepted  
**Date:** 2026-04-12

## Context

We need a front-end framework for the Kea dashboard — a single-page app showing agent session data, sitemap state, and test findings. The agent side already uses TypeScript, Vite, and RxJS. The operator prefers a lightweight, standards-aligned approach over a full framework like React or Angular.

## Decision

Use **Lit 4** (`lit` v4) as the component library.

## Rationale

- **Web-standard:** Lit compiles to native custom elements. No virtual DOM, no framework runtime beyond a thin reactive base class.
- **Decorator-driven:** `@customElement`, `@property`, `@state` mirror patterns the team is familiar with from Angular.
- **Small footprint:** ~5 KB minified+gzipped for the core library.
- **Interop:** Custom elements work in any HTML context. If we later embed dashboard widgets inside other tools, they just work.
- **Vite-native:** Lit needs zero plugins — Vite handles TypeScript + ES modules out of the box.

## Alternatives Considered

- **Angular** — Full framework, heavy for a dashboard. Overkill for a single SPA alongside an agent CLI.
- **React** — Requires JSX transform, larger runtime, no native custom element output without wrappers.
- **Vanilla web components** — Too much boilerplate for reactive rendering and state management.

## Consequences

- Team must learn Lit's reactive lifecycle (`willUpdate`, `updated`, `requestUpdate`).
- No built-in router — we'll add one if/when multi-page navigation is needed.
- Testing uses Vitest with DOM environment or happy-dom for component tests.
