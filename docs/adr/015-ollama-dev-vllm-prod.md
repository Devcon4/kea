# ADR-015: Ollama for Dev, vLLM for Production

**Status**: Accepted

## Context

Kea uses Gemma4 as its default local LLM. We needed to choose inference servers for both development and production environments. The server must expose an OpenAI-compatible API.

## Decision

- **Development**: Ollama — easy to install, manages model downloads, runs on CPU or consumer GPU. Default endpoint: `http://localhost:11434/v1`.
- **Production (K8s)**: vLLM — GPU-optimized inference server with continuous batching, PagedAttention, and high throughput. Deployed as a sidecar container or shared service.

Both expose the OpenAI chat completions API (`/v1/chat/completions`), so the agent code is identical in both environments. Only the `LLM_BASE_URL` environment variable changes.

## Alternatives Considered

- **Ollama everywhere**: Simple but lacks production-grade features. No continuous batching, lower throughput under load, less efficient GPU utilization. Fine for single-agent dev, not for a pool of agents sharing a GPU.
- **TGI (Text Generation Inference)**: HuggingFace's inference server. Good performance, OpenAI-compatible API. vLLM has broader model support and PagedAttention for better memory efficiency.
- **llama.cpp / llamafile**: C++ inference. Excellent for edge deployment but harder to manage model loading and doesn't provide the batching features needed for multi-agent workloads.
- **Cloud API (OpenAI, Anthropic)**: Would work via the same OpenAI client. Rejected as default because Kea's design principle is local-first — run entirely on your own infrastructure. Cloud APIs are supported as a fallback by changing env vars.

## Consequences

- The same `openai` npm package and `chat()` function work against both Ollama and vLLM. Zero code changes between environments.
- Dev setup is simple: `ollama pull gemma4` and go.
- Production gets continuous batching (multiple agent requests batched into one GPU forward pass), dramatically improving throughput.
- In K8s, vLLM can be deployed as:
  - **Sidecar**: One vLLM container per agent pod. Simple but each pod needs GPU access.
  - **Shared service**: Single vLLM Deployment + Service. All agent pods connect via cluster DNS. Better GPU utilization.
- The `LLM_MODEL` env var allows switching models (e.g., from Gemma4-12B in dev to Gemma4-27B in production) without code changes.
