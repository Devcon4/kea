# ADR-004: Stagehand for Browser Automation

**Status**: Accepted

## Context

Kea agents need to autonomously navigate websites, extract page structure, interact with elements, and build sitemaps. We needed a browser automation tool that works well with LLM-driven agents.

## Decision

Use Stagehand (by Browserbase) as the browser automation layer. Stagehand is a TypeScript library built on Playwright that provides three high-level primitives: `act()`, `extract()`, and `observe()`.

## Alternatives Considered

- **Playwright MCP**: Requires running an MCP server and connecting via MCP client protocol. Adds architectural complexity — Stagehand is a library we embed directly into the worker process.
- **Browser Use (Python)**: Python-only. Would force a multi-language agent stack or require a sidecar process.
- **Skyvern**: Cloud-hosted service. Adds external dependency and network latency for every browser action. Not suitable for air-gapped or on-prem deployments.
- **Raw Playwright**: Powerful but low-level. Would require building our own selector strategies, self-healing logic, and page extraction. Stagehand provides these out of the box.

## Consequences

- Stagehand uses the accessibility tree rather than vision models for page understanding. This is critical — it works with local models like Gemma4 that lack vision capabilities.
- Self-healing selectors mean tests are resilient to minor DOM changes.
- `act()`, `extract()`, and `observe()` map naturally to agent tool definitions for function calling.
- Stagehand bundles Playwright internally, so we get Playwright's browser support (Chromium, Firefox, WebKit) for free.
- The Dockerfile must install Playwright browser binaries, adding ~400MB to the image.
- Stagehand is a newer library — API stability risk is mitigated by pinning the version.
