# ADR-007: Google A2A Protocol for Agent Communication

**Status**: Accepted

## Context

Kea agents need to communicate with each other — a coordinator delegates tasks to navigator and tester agents. We needed a communication protocol for this multi-agent interaction.

## Decision

Use Google's Agent-to-Agent (A2A) Protocol v1.0 for all inter-agent communication. Each agent exposes an A2A-compliant interface with:

- An **Agent Card** at `/.well-known/agent-card.json` describing capabilities and skills.
- **Tasks** with lifecycle states (SUBMITTED → WORKING → COMPLETED/FAILED/CANCELED).
- **Messages** with typed **Parts** (text, data, files).
- JSON-RPC or HTTP+JSON transport.

## Alternatives Considered

- **Custom chatroom protocol**: Simpler to implement initially, but creates a proprietary communication format. A2A is an open standard that enables interop with other agent systems.
- **MCP (Model Context Protocol)**: Designed for tool/context serving, not agent-to-agent task delegation. MCP answers "what tools/context are available?" while A2A answers "please do this task and report back."
- **NATS/Redis pub-sub**: Low-level messaging. Would require designing our own task lifecycle, message format, and agent discovery on top. A2A provides all of these.
- **gRPC**: Good for service-to-service communication but doesn't define agent-specific concepts (tasks, skills, agent cards). Would be reinventing A2A's semantics.

## Consequences

- Standardized task lifecycle (submitted → working → completed/failed) with clear terminal states.
- Agent Cards enable runtime discovery — the coordinator can inspect what skills each agent offers.
- The protocol supports streaming (SSE) for real-time task updates, though we start with request/response.
- A2A is transport-agnostic — we use HTTP+JSON initially but can add gRPC later.
- Other A2A-compliant agents (external or third-party) can participate in Kea's agent pool without code changes.
- The protocol is relatively new (2024). Spec may evolve, but our typed implementation (see `a2a/types.ts`) isolates protocol changes to one module.
