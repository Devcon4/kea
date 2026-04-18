# ADR-001: Monorepo Structure

**Status**: Accepted

## Context

Kea consists of two primary components: a TypeScript agent worker and a Go Kubernetes operator. We needed to decide whether to use separate repositories or a single monorepo.

## Decision

Use a single monorepo with top-level directories:

```
kea/
├── agent/        # TypeScript worker
├── operator/     # Go K8s operator
├── deploy/       # Helm/Kustomize manifests
└── docs/         # Documentation + ADRs
```

## Alternatives Considered

- **Separate repositories**: One for the agent worker, one for the operator. Rejected because the two components are tightly coupled — CRD changes in the operator often require matching changes in the agent's HTTP API. Separate repos add coordination overhead (cross-repo PRs, version pinning).
- **Go monorepo with embedded TS**: Rejected because Go and Node.js have fundamentally different build toolchains. A flat monorepo with separate directories is simpler.

## Consequences

- Atomic commits across agent and operator changes.
- Single CI pipeline can build, test, and release both components.
- Each directory maintains its own dependency management (`package.json` vs `go.mod`).
- Contributors need both Go and Node.js toolchains installed for full development, though each component can be worked on independently.
