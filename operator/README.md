# Kea Operator

The operator package runs the Kubernetes controller that reconciles Kea `AgentPool`, `TargetResource`, and `TestPlan` custom resources.

## TestPlan surface status

**TestPlan CRD**: deferred to a follow-up FDD; the agent-side surface for feature/test-plan authoring lives in `@kea/api`'s `/sessions/:id/features` endpoint (see [FDD-0010](../docs/fdd/0010-feature-driven-test-planning.md), [ADR-024](../docs/adr/024-features-as-canonical-spec.md)).
