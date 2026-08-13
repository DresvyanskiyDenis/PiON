# Paths and trust

Two files decide what the agent treats as familiar ground, plus the per-project override mechanism.

**Both are generated, not tracked.** `config/trusted-roots.default.json` and
`config/path-defaults.default.json` are the templates in git; the installer copies each to its
`.json` twin and rewrites the roots **from your machine**, so nothing about whoever built the
repository leaks into yours. The generated pair is git-ignored and is what runs.

These two carry real filesystem paths, which is exactly why they are the pair that most needs the
split: a `--prefix` test run once wrote a scratch directory into the tracked `trusted-roots.json` and
it survived into the working copy. The templates below are what a fresh clone contains — your
generated files will differ, and should.

---

## `trusted-roots.json`

Read by [`extensions/trust`](../extensions/trust.md).

```json
{
  "version": 1,
  "roots": ["~/projects", "~/pi-config"],
  "note": "…"
}
```

PI asks a **project-trust** question the first time it meets a directory: may this project's own
`.pi/` contribute extensions, hooks, skills, agents and MCP servers to the session? Trusting a
directory means agreeing that a repository you just cloned may execute its own TypeScript on your
machine, in your environment.

`trust.ts` answers **"yes" automatically inside these roots and "undecided" everywhere else**, so
PI's own prompt still runs for everything you did not list.

**The template's roots are illustrative, not a recommendation.** The installer replaces them with the
roots you name, and appends the stable path `~/pi-config` so the harness can trust its own checkout.
A root that does not exist is skipped.

!!! danger "This is the narrow alternative to a setting that was rejected as too broad"
    `defaultProjectTrust: "always"` in [`settings.json`](settings.md#trust) would answer *yes* for
    every directory anywhere, forever. Nothing in `bin/pi-check` stops you setting it. This file
    exists so you can get the same convenience for the handful of directories you actually own, and
    keep the prompt for the fifty you clone from strangers.

**What breaks if you get it wrong:** listing `~` or `/` here is functionally identical to the
setting the harness rejects, and defeats the whole gate. Listing a directory where you clone
third-party code is the same mistake in a smaller box. Keep the list to trees whose contents you
write.

---

## `path-defaults.json`

Read by [`extensions/path-defaults`](../extensions/path-defaults.md). Sets a default tier and a
per-channel policy **per directory root**, so a session's posture follows where it was started.

```json
{
  "version": 1,
  "roots": [
    {
      "path": "~/projects",
      "tier": "strong",
      "egress": { "web": "allow", "mcp": "allow", "publicModels": "allow" }
    },
    {
      "path": "*",
      "tier": "fast",
      "egress": { "web": "allow", "mcp": "allow", "publicModels": "allow" }
    }
  ]
}
```

| Key | Meaning |
|---|---|
| `path` | a directory prefix, `~` expanded. `"*"` is the catch-all and should be **last** |
| `tier` | the default tier for sessions started under this root |
| `egress.web` | `allow` \| `deny` — may this session use `web_search` / `web_fetch` |
| `egress.mcp` | `allow` \| `deny` — may this session use MCP tools |
| `egress.publicModels` | `allow` \| `deny` — may this session dispatch onto a `public`-class provider |

Matching is by longest prefix; the catch-all row applies to everything else.

The installer rewrites this array whole rather than patching it row by row — it points the first row
at the first trusted root you named and keeps `"*"` last, because `path-defaults` matches in order
and a `"*"` in front of a specific root would swallow every session. Add a row for any tree that
deserves a different posture; a directory holding material that must not reach a third party is the
obvious case:

```json
{ "path": "~/sensitive", "tier": "confidential",
  "egress": { "web": "deny", "mcp": "deny", "publicModels": "deny" } }
```

!!! warning "Same honesty caveat as egress classes: this is declarative, not a network boundary"
    `publicModels: "deny"` refuses a *dispatch*. Nothing here intercepts a socket, and nothing
    stops a process the agent already started from reaching the network. If you need an actual
    boundary, build one at the network layer.

**What breaks:** a `tier` naming an unbound tier makes every session under that root fail at load.
Since `confidential` and `local` ship unbound in
[`routing.default.json`](routing.md#tiersunbound), bind the tier before you point a root at it.

Omitting the `"*"` catch-all leaves directories outside every root with no default; put it last and
leave it there.

---

## Per-project settings

A project may carry its own `.pi/settings.json`, deep-merged **over** the global
[`settings.json`](settings.md) — but **only after the project is trusted**.

`config/project-settings.example.json` is the template to copy:

```json
{
  "defaultProvider": "databricks",
  "defaultModel": "databricks-claude-sonnet-4-5",
  "defaultThinkingLevel": "medium",
  "enabledModels": ["databricks-claude-sonnet-4-5", "databricks-gpt-oss-120b"],
  "skills": [".pi/skills"],
  "prompts": [".pi/prompts"],
  "packages": [],
  "compaction": { "keepRecentTokens": 28000 },
  "externalEditor": "code --wait"
}
```

Copy it to `<project>/.pi/settings.json` and cut it down to the keys you actually want to change.
The example is written around a work tree that must stay on an in-boundary provider — which is the
main reason to use the mechanism at all.

| Key | Why it is in the example |
|---|---|
| `defaultProvider` / `defaultModel` | pin this project to a provider inside your boundary |
| `enabledModels` | **narrow the `/model` picker to a safe subset** for this project. The most under-used key in the file |
| `skills` / `prompts` | project-local resources, loaded only when trusted |
| `compaction.keepRecentTokens` | a project with long mechanical edits wants more recent context kept |

Other files a trusted project may contribute: `.pi/hooks.yaml` (merged after the global rules),
`.pi/agents/` (via `dispatch.json`'s `registryDirs`), `.pi/skills/` (rank 0, the highest skill
precedence), and — subject to the default-deny approval ledger — MCP server definitions. See
[`mcp.json`](mcp.md).

!!! danger "Everything on this page is downstream of the trust decision"
    A project's `.pi/` is inert until the project is trusted, and trusting it enables all of the
    above at once. There is no per-file trust. If you are unsure about a repository, answer *no* —
    the agent still works, it just does not read that project's opinions.

---

## Related

- [`settings.json`](settings.md#trust) — `defaultProjectTrust`
- [Safety model](../concepts/safety-model.md) — the trust gate and the deadman
- [trust](../extensions/trust.md), [path-defaults](../extensions/path-defaults.md)
