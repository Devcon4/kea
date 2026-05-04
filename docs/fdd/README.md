# Feature Design Documents (FDDs)

An FDD is a **feature card**: a PM/UX hand-off describing one product feature in user-visible terms — who needs it, what they should be able to do, what counts as done. It travels with the feature from proposal to ship and after.

For one-shot architectural decisions that don't describe a feature (language choice, framework choice, code-style rules), use an [ADR](../adr/) instead. ADRs record *how the system is built*; FDDs record *what the product promises*.

> **Before writing one, read [`AGENTS.md`](AGENTS.md).** It pins the voice, scope, and what an FDD is not.

---

## Lifecycle

```
Proposed ──► Accepted ──► In Progress ──► Shipped
   │            │               │            │
   ▼            ▼               ▼            ▼
 Deprecated / Superseded by FDD-XXXX (any state may end here)
```

| Status | What it means |
|---|---|
| **Proposed** | Draft circulating for review. Stories, requirements, and acceptance criteria are still moving. |
| **Accepted** | Reviewed and approved. Engineering may begin. |
| **In Progress** | Actively being built. Open questions get resolved here, not silently. |
| **Shipped** | The feature exists and the document accurately describes its product promise. |
| **Deprecated** | Feature still exists but new work **MUST NOT** depend on it. |
| **Superseded by FDD-XXXX** | A newer FDD owns this product surface. |

After ship, the FDD is a frozen record of what the feature was meant to do. Substantive product changes spawn a new FDD that supersedes the old one — they do **NOT** rewrite history. Small factual corrections are fine.

## Numbering & scope

- Single global sequence: `0001`, `0002`, … (4 digits, matches the file prefix).
- `Scope:` names the package(s) the feature lives in. Same vocabulary as ADRs.
- Multi-package features use `Scope: project`.

## Relationship to ADRs

- **ADR**: "we picked Postgres over SQLite" — frozen technical decision.
- **FDD**: "operators need their crawls to survive a pod restart" — product promise.

A complex feature usually cites 1–N ADRs in its `Related ADRs:` field. A new FDD that needs a cross-cutting technical decision spawns an ADR alongside it.

## Index

| FDD | Title | Scope | Status |
|---|---|---|---|
| [0001](0001-automated-site-exploration.md) | Automated Site Exploration | agent | Shipped |
| [0002](0002-pluggable-specialist-agents.md) | Pluggable Specialist Agents | agent | Superseded by [0009](0009-pi-extension-specialists.md) |
| [0003](0003-crawl-session-management.md) | Crawl Session Management | project | Shipped |
| [0004](0004-sitemap-visibility.md) | Sitemap Visibility | project | Shipped |
| [0005](0005-findings-reporting.md) | Findings Reporting | project | Shipped |
| [0006](0006-live-agent-activity-stream.md) | Live Agent Activity Stream | project | Shipped |
| [0007](0007-declarative-crawl-fleets.md) | Declarative Crawl Fleets | operator | Accepted |
| [0008](0008-operator-dashboard.md) | Operator Dashboard | dashboard | Shipped |
| [0009](0009-pi-extension-specialists.md) | Pi-Extension Specialist Agents | agent | Accepted |

> **Maintenance:** When adding an FDD, append one row here and one in the root `AGENTS.md` FDD index.

## Authoring tips

- **Lead with the role, not a persona.** Name the role, the moment, and the outcome. No invented people or biographical scenes.
- **Pin scope with WILL NOT.** Boundaries belong in the Functional requirements list, not a separate "Out of scope" block.
- **Make acceptance criteria observable.** A criterion a stakeholder can't witness is not a criterion.
- **List alternatives.** If you didn't consider any, you didn't think hard enough.
- **No file paths in the body.** Code locations belong in the trailing **Engineering hand-off** section, lightly.
- **Link, don't copy.** If another FDD owns a concept, cite it instead of restating it.

## Template

See [`template.md`](template.md). Persona and voice rules live in [`AGENTS.md`](AGENTS.md).
