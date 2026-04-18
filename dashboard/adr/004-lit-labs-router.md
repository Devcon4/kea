# ADR-004: @lit-labs/router for Client-Side Routing

**Status:** Accepted  
**Date:** 2026-04-12

## Context

The dashboard is a single-page application that will grow to include multiple views — session list, session detail, findings, settings. We need client-side routing with history API support and a pattern that integrates cleanly with Lit's reactive controller model.

## Decision

Use **`@lit-labs/router`** for client-side routing.

## Rationale

- **Lit-native:** `Router` extends `Routes` which implements `ReactiveController`. It plugs directly into the host element's lifecycle — no adapters needed.
- **URLPattern-based:** Route matching uses the standard `URLPattern` API (with polyfill). Pattern syntax like `/sessions/:id` is familiar and standards-track.
- **Hierarchical:** Child components can define nested `Routes` controllers, enabling route composition without a central route table.
- **Lightweight:** ~2 KB. Intercepts `<a>` clicks and `popstate` events, renders via an `outlet()` callback.
- **Same ecosystem:** Maintained alongside Lit in the `lit/lit` monorepo under `@lit-labs/`.

## API

```ts
private router = new Router(this, [
  { path: "/", render: () => html`<kea-session-list></kea-session-list>` },
  { path: "/sessions/:id", render: ({ id }) => html`<kea-session-detail .sessionId=${id}></kea-session-detail>` },
]);

render() {
  return html`${this.router.outlet()}`;
}
```

- `Router` (root-level) installs global click/popstate handlers.
- `Routes` (nested) matches against the remaining tail of the URL.
- `router.goto("/sessions/abc")` for imperative navigation.
- `router.link("/sessions/abc")` for building href strings.

## Alternatives Considered

- **@vaadin/router** — Popular but designed for Vaadin's ecosystem. Heavier, imperative API.
- **Custom hash router** — Trivial but loses history API benefits and doesn't compose.
- **No router (conditional rendering)** — Fine initially but doesn't scale; loses URL-based state.

## Consequences

- `@lit-labs/router` is still in labs — API may change. Risk is low since routing APIs are fairly stable.
- The `Router` should only be instantiated once (in `kea-app`). Nested routes use `Routes`.
- SPA fallback in production (nginx `try_files $uri /index.html`) is required — already handled in the Dockerfile.
