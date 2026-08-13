# ADR 0003: Vendor the MCP adapter in-tree

- **Status:** accepted
- **Date:** 2026-08-07 (the date `pi-packages/vendor.lock.json` records)

## Context

MCP servers are the highest-consequence extension point in the whole system. An MCP server can be a
child process spawned on your machine, holding a copy of your environment, started during session
initialisation — that is, **before any tool call exists for the permission layer to see**. So
`git clone <hostile-repo> && cd <repo> && pi` is, with no gate, sufficient to run a program of the
repository author's choosing with every credential you have exported.

The MCP support in this harness comes from a community package, `pi-mcp-adapter` (MIT, Nico Bailon).
It is good code and it does not have that gate, because upstream is not making the same assumptions
we are: it treats a project's MCP config as a legitimate config source and merges it.

The gate has to sit at exactly one place — `getConfigSources()`, where project-declared sources are
collected before being merged. There is no hook, no wrapper position and no event outside that
function which observes project sources *before* they are merged. We looked; that is why this ADR
exists rather than a paragraph in a module header.

A second patch is needed at the spawn path: a project-sourced stdio server must be wrapped in the
environment-minimising `mcp-stdio-guard` **whether or not it asked to be**, which again is a change
inside the package rather than around it.

Three ways to change code you do not own:

1. patch it at install time (`postinstall`, `patch-package`, a `sed` in the installer);
2. fork it and depend on the fork;
3. vendor the source in-tree and patch the copy.

## Decision

**Vendor it.** `pi-packages/pi-mcp-adapter/` holds the 2.20.1 source, MIT LICENSE included, with the
local patches applied in place and described in
[Third-party components](../reference/third-party.md). `config/settings.json` points `packages` at
that directory rather than at `node_modules/`.

Integrity is enforced mechanically. `pi-packages/vendor-files.lock.json` records a sha256 per file
and `bin/pi-check`'s `PC-21` fails the repository when the tree on disk stops matching. A deleted or
altered vendored file is a build failure, not a surprise at runtime — which matters most for
`stdio-guard.ts`, whose loss would silently disarm the environment-minimising layer.

`PC-17` separately requires that every installed or vendored tree ships a licence file.

## Consequences

**Positive**

- The patch is **visible in a diff**. Anyone reviewing this repository can read exactly how our
  behaviour differs from upstream's, in the same review as everything else.
- It is re-appliable. A version bump is a merge with a known base, not an archaeology exercise.
- It cannot silently disappear. `PC-21` fails if the bytes move.
- The vendored tree keeps its own LICENSE and its attribution survives, which an install-time patch
  actively obscures.

**Negative**

- We now carry someone else's source and its maintenance burden. Upstream security fixes arrive only
  when we go and get them.
- The diff against upstream grows stale silently. The mitigation is procedural — re-apply on every PI
  or adapter bump — and procedure is weaker than mechanism.
- It enlarges the repository and puts third-party code in our commit history, which needs the
  attribution page to stay accurate.
- A reader may reasonably mistake vendored code for ours. Every vendored file is under one directory
  for that reason.

**Neutral**

- Dependency count is not treated as a cost in this project, so "one fewer npm dependency" is neither
  an argument for nor against.

## Alternatives considered

- **`postinstall` patch / `patch-package`.** Rejected as the worst option despite being the most
  common: it rewrites somebody else's package invisibly, after review, on every machine, and a failed
  patch application is easy to miss. A security control applied by a script nobody reads is a security
  control you are guessing about.
- **Fork the package publicly and depend on the fork.** Honest and viable. Rejected on maintenance
  cost for a two-patch delta, and because the fork's relationship to upstream becomes another thing to
  document and keep current. Worth revisiting if the delta ever grows.
- **Upstream the patch.** Attempted reasoning first, and still the right long-term answer for patch 1
  (the trust gate is generally useful). Rejected as the *only* strategy because it is not ours to
  schedule: we would be unprotected for however long review takes, and patches 2 and 3 encode a
  posture upstream may reasonably not want as a default.
- **Do without the package.** Write our own MCP client. Rejected: it is a large, protocol-tracking
  surface, and writing it ourselves trades a reviewed dependency for an unreviewed one.

## Related

- [Third-party components](../reference/third-party.md) — the package, the licence, and each patch
- [Safety model](../concepts/safety-model.md#why-some-code-is-in-tree)
- [Adding an MCP server](../extending/mcp-servers.md)
