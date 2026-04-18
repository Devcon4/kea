# ADR-014: esbuild for Bundling

**Status**: Accepted

## Context

The agent worker's TypeScript code must be compiled and bundled for production deployment. The bundle runs in a Node.js container image.

## Decision

Use esbuild to bundle the agent into a single ESM file targeting Node.js 22:

```bash
esbuild src/index.ts --bundle --platform=node --target=node22 --format=esm --outdir=dist --packages=external
```

The `--packages=external` flag keeps `node_modules` as external imports (resolved at runtime from the container's `node_modules`), avoiding bundling native addons like `better-sqlite3`.

## Alternatives Considered

- **tsc only**: TypeScript compiler produces JavaScript but doesn't bundle. Results in many small files that are slower to load and harder to deploy. No tree shaking.
- **Vite**: Uses esbuild for dev and Rollup for production builds. The Rollup layer adds complexity and slower builds. Since we're targeting Node.js (not a browser), Vite's dev server features aren't useful.
- **Rollup**: More configurable than esbuild but significantly slower. Configuration is verbose. Our build needs are simple enough that esbuild's defaults work.
- **tsgo**: TypeScript compiler rewrite in Go. Promising but not yet stable enough for production use. Can revisit when it reaches 1.0.
- **Webpack**: Heaviest option. Configuration complexity is legendary. No advantage over esbuild for a Node.js server bundle.

## Consequences

- Sub-second builds. esbuild compiles the entire agent in <100ms.
- Single output file simplifies Docker COPY and startup.
- Native addons (better-sqlite3) are kept external — they must be installed in the container's `node_modules` via `npm ci --omit=dev`.
- Tree shaking removes unused code paths.
- esbuild doesn't type-check — `tsc --noEmit` is run separately for type validation. This is a feature, not a bug: it separates concerns and keeps builds fast.
