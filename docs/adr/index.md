# Architecture decisions

Five decisions shape most of what is surprising about this repository. They are recorded here so a
reader who disagrees can see the argument rather than guess at it, and so a contributor who wants to
reverse one knows what they are arguing against.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-no-provider-failover.md) | A provider error aborts the turn. There is no failover and no substitution | Accepted |
| [0002](0002-fail-open-guard-fail-closed-hooks.md) | The guard fails open on an internal error; hooks fail closed | Accepted |
| [0003](0003-vendor-the-mcp-adapter.md) | The MCP adapter is vendored in-tree and patched, rather than patched at install time | Accepted |
| [0004](0004-egress-classes-are-declarative.md) | Egress classes are a declarative control and are never described as a network boundary | Accepted, amended 2026-08-13 (the dispatch-time containment check was withdrawn) |
| [0005](0005-unbounded-fan-out-on-runs-all.md) | A wide `runs.all` fan-out is not width-capped; the gap is documented rather than enforced | Accepted |

These were recorded when the repository was published; the decisions themselves are older, and each
ADR says what evidence it rests on. Where a date could be tied to something in the tree — a lock
file, a review — the ADR names it.

## Writing another one

Copy the shape: **Context** (the forces, not the conclusion), **Decision** (one sentence, then the
mechanism), **Consequences** (positive, negative, neutral — a negative section that says "none" is a
sign the decision was not real), **Alternatives considered** with the reason each was rejected.

Number it sequentially. An ADR is never edited after acceptance except to change its status; a
changed mind is a new ADR that supersedes the old one.
