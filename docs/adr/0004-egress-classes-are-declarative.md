# ADR 0004: Egress classes are declarative, not a network boundary

- **Status:** accepted
- **Date:** 2026-08-13 (recorded at publication; the decision is older)

## Context

Every provider in this harness carries an **egress class**: `public`, `internal` or `confidential`.
The dispatch ceiling uses it to refuse a sub-agent dispatch whose class exceeds its parent's, and
`config/path-defaults.json` uses a related `egress` block to decide, per directory root, whether a
session may use web tools, MCP tools, or a public-class model at all.

The words invite a stronger reading than the mechanism supports. "Confidential" sounds like a
guarantee about where bytes go. It is not one. Nothing in this repository inspects, proxies or blocks
a socket. The controls are:

- a check at dispatch time, before a sub-agent is created;
- a check at load time, when a session's posture is resolved from its directory;
- and configuration that decides which endpoint a request is *addressed* to.

Everything after that is the operating system's business. A `bash` command the agent runs can open any
connection your user can open. An MCP server, once started, talks to whatever it likes. A process the
agent spawned and then stopped tracking keeps running.

There is a strong temptation to describe this as "egress control", because that phrasing makes the
feature sound finished, and because most readers will never test it. That is exactly why the
temptation has to be settled once, in writing.

## Decision

**The egress classes are a declarative control. No document in this repository describes them as a
network boundary, and the honest limitation is stated on every page where the words appear.**

Concretely:

- The reference pages say what is checked and when: a dispatch is refused; a session posture is
  resolved. They do not say "traffic is blocked", because it is not.
- [Known limitations](../limitations.md) states the gap in plain language rather than burying it.
- `publicModels: "deny"` is documented as refusing a *dispatch*, with an explicit note that nothing
  intercepts a socket.
- Anyone needing a real boundary is pointed at the network layer, where boundaries live.

This is a documentation decision with a code consequence: a proposal that would only work if the
classes were enforced at the network layer gets rejected at the design stage rather than half-built.

## Consequences

**Positive**

- Nobody builds a workflow on a guarantee that does not exist. That is the entire benefit and it is
  worth more than the marketing.
- The `confidential` tier's real value stays visible and is genuinely strong: the request is
  *addressed* to an endpoint inside a boundary you control, and [ADR 0001](0001-no-provider-failover.md)
  guarantees it is never silently re-addressed to a public one.
- A security reviewer reading these docs finds the gap stated rather than having to discover it, which
  is the difference between a caveat and a finding.

**Negative**

- The feature reads as weaker than a competitor's identically-named one. Some of those are equally
  declarative and do not say so; we lose that comparison on paper.
- Users who want a real boundary have to build it themselves, outside this repository.
- Every page mentioning egress carries a caveat, which is repetitive by design.

**Neutral**

- Nothing prevents adding real enforcement later — an egress proxy, a per-session network namespace.
  If that lands, this ADR gets superseded rather than quietly reinterpreted.

## Alternatives considered

- **Enforce it for real, in-process.** Intercept `fetch` and the socket APIs inside the agent.
  Rejected: it covers only network calls made by *our* code, and misses every subprocess and every MCP
  server — which is where the risk actually is. Partial enforcement that looks total is worse than
  none.
- **Enforce it at the OS level** (network namespace, firewall rules, a sandbox with no network).
  Genuinely correct, and out of scope: it is a machine-provisioning concern, it is per-platform, and
  an OS-level sandbox package was reviewed and deliberately not relied on.
- **Route everything through a mandatory egress proxy.** Real enforcement for HTTP, and a large piece
  of infrastructure for every user to run. Rejected as a default; nothing stops an operator doing it,
  and `config/providers/openai.json` already carries the shape for a proxied provider.
- **Drop the classes entirely, since they do not enforce.** Rejected: the dispatch ceiling is a real
  check that catches a real mistake — a confidential-tier agent delegating to a public-tier one — and
  removing the vocabulary would remove the only place that mistake is currently caught.

## Related

- [Safety model](../concepts/safety-model.md)
- [Known limitations](../limitations.md)
- [Paths and trust](../configuration/paths-and-trust.md) — the per-root `egress` block
- [ADR 0001](0001-no-provider-failover.md) — why a confidential request is never re-addressed
