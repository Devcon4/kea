# ADR-003: Go + Kubebuilder for K8s Operator

**Status**: Accepted

## Context

Kea needs a Kubernetes operator to manage pools of agent pods, target resources, and test plans via Custom Resource Definitions (CRDs).

## Decision

Use Go with Kubebuilder v4 and controller-runtime. Define three CRDs under `chaos.kea.dev/v1alpha1`:

- **AgentPool**: Manages a set of agent pods (replicas, image, target reference).
- **TargetResource**: Defines the target website (URL, auth config).
- **TestPlan**: Describes test steps and manual instructions.

## Alternatives Considered

- **Operator SDK**: Built on Kubebuilder but adds extra abstraction layers (Ansible, Helm modes). We only need the Go mode, so Kubebuilder directly is simpler.
- **TypeScript operator (kopf-like)**: Would unify the language stack, but the Kubernetes client-go ecosystem is far more mature. Controller-runtime provides battle-tested reconciliation patterns.
- **Metacontroller**: Declarative webhooks approach. Too limited for our pod lifecycle management and cross-resource coordination needs.
- **KUDO**: Deprecated.

## Consequences

- Kubebuilder scaffolding provides CRD generation, RBAC, webhook support, and envtest harness.
- controller-runtime's reconciliation loop handles leader election, caching, and event filtering.
- Go compile produces a single static binary — ideal for minimal container images.
- Contributors working only on the agent don't need Go installed.
- envtest + Ginkgo/Gomega provide integration testing against a real API server without a full cluster.
