# FDD-NNNN: <Feature Name>

**Status**: Proposed <!-- Proposed | Accepted | In Progress | Shipped | Deprecated | Superseded by FDD-XXXX -->
**Scope**: project <!-- project | agent | api | dashboard | operator | shared -->
**Related ADRs**: — <!-- e.g. 007, 020 -->
**Supersedes**: — <!-- e.g. FDD-0003 -->

> One paragraph. A reader who only reads this should know **who** wants the feature, **what** it lets them do, and **why** it matters. Product-flavored — no implementation language.

---

## Problem

What is wrong, missing, or painful **today**, in abstract terms. Name the role and the friction; do **not** invent personas or biographical scenes. Stay concrete about the moment of pain (the question they can't answer, the workaround they invent) without dressing it up as a story.

> Bad: "Operators lack visibility into crawl status."
> Bad: "Sarah opens the dashboard at 9am and can't tell what broke overnight."
> Good: "When an overnight crawl fails, the operator can't tell from the dashboard which page broke it without re-running the whole crawl."

## Users & context

- **Primary actor**: e.g. *Operator* (the role triaging crawls)
- **Secondary actors**: only if they directly interact with this feature
- **Frequency / context**: how often, in what setting, under what time pressure

## User stories

- **As a** \<role\>, **I want** \<observable capability\>, **so that** \<outcome they care about\>.

Each story must map to ≥ 1 acceptance criterion below. If it doesn't, delete the story or add the criterion.

## Requirements

State requirements with RFC 2119 weight. Use **WILL NOT** / **MUST NOT** for the boundaries of the feature — that is where scope is pinned.

### Functional

- The system **MUST** …
- The system **MUST NOT** …
- The system **SHOULD** …
- The system **WILL NOT** … (and why, in one clause)

### Non-functional

- **Performance**, **Reliability**, **Security / privacy**, **Accessibility**, **Operational** — only the categories that apply.

## Acceptance criteria

Concrete, observable, testable. A QA engineer or stakeholder must be able to witness each one.

- **Given** \<state\>, **When** \<actor does X\>, **Then** \<observable Y\> within \<bound\>.
- **Given** \<failure mode\>, **When** \<…\>, **Then** the actor sees \<truthful surface\>.

Failure-mode criteria are as load-bearing as happy-path criteria.

## Alternatives considered

- **Option A** — rejected because …
- **Option B** — rejected because …

## Open questions

- [ ] …

---

## Engineering hand-off

> The only place code locations may appear. Bullets only — no architecture, no schemas. > 8 lines means you've drifted into engineering reference; move it elsewhere.

- **Likely surface area**: which package(s) gain new code; which stay untouched.
- **Constraints from existing decisions**: link the ADRs that pin choices.
- **Tests required**: kind of coverage expected (unit / integration / e2e), no file paths.

---

## Cross-references

- **Related FDDs**: —
- **Related ADRs**: —
