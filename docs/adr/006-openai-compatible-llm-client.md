# ADR-006: OpenAI-Compatible LLM Client

**Status**: Accepted

## Context

Kea uses Gemma4 as its default LLM, served locally by Ollama (dev) or vLLM (production). We needed a client strategy that doesn't lock us into a specific inference backend.

## Decision

Use the `openai` npm package as the LLM client. Both Ollama and vLLM expose an OpenAI-compatible chat completions API (`/v1/chat/completions`). The client is configured via environment variables:

- `LLM_BASE_URL` — inference server endpoint (default: `http://localhost:11434/v1`)
- `LLM_API_KEY` — API key (default: `ollama`)
- `LLM_MODEL` — model name (default: `gemma4`)

## Alternatives Considered

- **ollama-js**: Ollama's official client. Works well for Ollama but doesn't support vLLM or cloud providers. Would require a second client for production.
- **Custom fetch client**: Minimal dependency, but we'd lose the OpenAI package's TypeScript types for tool calling, streaming, and structured outputs. Those types are complex and well-maintained.
- **LiteLLM proxy**: Python proxy that normalizes many LLM APIs. Adds an extra process to deploy and manage. Unnecessary since Ollama/vLLM already speak OpenAI format natively.
- **Vercel AI SDK**: Larger abstraction. Adds framework-level concepts (streams, providers) that we don't need. The raw OpenAI client is sufficient.

## Consequences

- Switching from Ollama to vLLM to OpenAI to Anthropic (via proxy) is a one-line env var change.
- Full TypeScript types for chat completions, tool calls, and structured outputs.
- The `openai` package is the de facto standard — every new LLM provider targets compatibility with it.
- Tool calling format is standardized. Agent tool definitions work across all backends.
- We depend on the OpenAI SDK's release cycle, but it's actively maintained and follows semver.
