# `config/dispatch.json` and `agents/` — sub-agents

**Tracked in git. Edit in place.** Read by `extensions/dispatch/config.ts`. Not asked about during
installation — this is a tune-later file.

`dispatch.json` holds the *defaults and limits* for sub-agent dispatch. The agents themselves are
Markdown files with YAML frontmatter, one per agent, in `agents/`.

---

## Shipped file

```json
{
  "maxDepth": 2,
  "defaultTier": "fast",
  "defaultEgress": "internal",
  "defaultTimeoutMs": 1800000,
  "concurrencyDefault": 3,
  "packageDefaultConcurrency": 4,
  "registryDirs": ["<repo>/agents", "<repo>/agents-private",
                   "<agentDir>/agents", "<cwd>/.pi/agents"],
  "dispatchTools": ["subagent", "subagent_run", "dispatch_agent", "task", "agent"],
  "genericAgents": ["general-purpose", "general", "generalist"],
  "specialistMatchMinScore": 2
}
```

---

## `maxDepth`

Ships **`2`**. How deep sub-agents may nest: the main session dispatches a child (depth 1), that
child may dispatch a grandchild (depth 2), and a great-grandchild is refused.

**Who would change it:** raise it to 3 if you genuinely run a coordinator that spawns coordinators.
Lower it to 1 if you want a flat fan-out and nothing else.

**What breaks if you get it wrong:** the failure of an unbounded depth is not a crash, it is cost.
Each level multiplies token spend by the fan-out, and a model that has decided delegation is the
answer will keep deciding that. A depth limit is a budget, and `2` is deep enough to be useful and
shallow enough to notice.

---

## `defaultTier` and `defaultEgress`

| Key | Ships | Meaning |
|---|---|---|
| `defaultTier` | `"fast"` | The tier an agent gets when its frontmatter declares no `model:` |
| `defaultEgress` | `"internal"` | The egress ceiling an agent gets when it declares no `egress:` |

`defaultEgress: "internal"` is the interesting one. It is deliberately *not* `public`: an agent
that forgot to declare its sensitivity gets the middle class, so it can reach an internal provider
but the egress check still has something to compare against. Setting it to `confidential` would
make every undeclared agent claim the highest sensitivity and fail against a public provider —
loud, but for the wrong reason.

**What breaks:** `defaultTier` naming a tier that is unbound in `routing.json` means every
undeclared agent fails at load. Since `confidential` and `local` ship unbound, do not default to
either.

---

## `defaultTimeoutMs`

Ships `1800000` — thirty minutes. The wall-clock budget for one sub-agent run.

Raise it for genuinely long jobs; a research sweep across many sources can exceed it. Lower it if
you would rather find out early that an agent is stuck in a loop. A timed-out sub-agent returns a
failure to its parent, which the parent can see and react to — it does not silently return partial
work.

---

## `concurrencyDefault` and `packageDefaultConcurrency`

| Key | Ships | Meaning |
|---|---|---|
| `concurrencyDefault` | `3` | Parallel sub-agents when the resolved provider has no row in `routing.json`'s `concurrency` |
| `packageDefaultConcurrency` | `4` | The underlying package's own default |

Per-provider caps in [`routing.json`](routing.md#concurrency) win over both. That is where
`local: 1` lives, and that is the entry that encodes a physical fact rather than a preference.

---

## `registryDirs`

Where agent definitions are discovered, in order:

```json
["<repo>/agents", "<repo>/agents-private", "<agentDir>/agents", "<cwd>/.pi/agents"]
```

| Placeholder | Resolves to |
|---|---|
| `<repo>` | your clone |
| `<agentDir>` | `$PI_CODING_AGENT_DIR`, i.e. `~/.pi/agent` |
| `<cwd>` | the directory `pi` was started in |

`<repo>/agents-private` is gitignored and will not exist on a fresh clone; a missing directory is
skipped, not an error. It is the intended home for agents you do not want to publish.

`<cwd>/.pi/agents` makes an agent definition part of a project. It is loaded on the same terms as
everything else in `<cwd>/.pi/` — **only after the project is trusted**.

---

## `dispatchTools`

```json
["subagent", "subagent_run", "dispatch_agent", "task", "agent"]
```

The tool names that count as dispatch. The registered tool is `subagent`; the rest are aliases
other packages and older prose use. The list is wide on purpose — a routing rule that misses
because the tool was called `task` is a rule that does not exist.

The same list appears in [`config/guard.json`](guard.md#dispatchtools) for the `RTE-*` veto. Add a
new dispatch tool to both.

---

## `genericAgents` and `specialistMatchMinScore`

```json
"genericAgents": ["general-purpose", "general", "generalist"],
"specialistMatchMinScore": 2
```

Together these implement one rule: **do not dispatch a generic agent when a specialist matches.**
A request is scored against each specialist's `description`; if the best specialist scores at least
`specialistMatchMinScore` and the model asked for a generic agent by one of the `genericAgents`
names, the specialist is suggested instead.

Raise `specialistMatchMinScore` if you get false matches — the specialist is being suggested for
work it does not do. Lower it to `1` if you have few, sharply-scoped agents and want the nudge to
fire more readily.

**What breaks:** nothing hard. This is a suggestion layer. Setting the score very low turns it into
noise the model learns to ignore, which is the real cost.

---

## Agent definitions

One Markdown file per agent, frontmatter plus the system prompt as the body:

```markdown
---
name: code-reviewer
description: Use for thorough code review of a PR or committed branch — correctness,
  security, performance, maintainability, test adequacy. Read-only.
tools:
  - read
  - grep
  - find
  - bash
model: strong          # a TIER name — or provider/id for a deliberate pin
egress: internal       # the maximum sensitivity this agent may handle
returns: object
---

You are a code reviewer. …
```

| Field | Notes |
|---|---|
| `name` | must match the filename |
| `description` | **the field that decides whether the agent is ever used.** It is what the orchestrating model reads and what specialist matching scores against. Write it as *when to use this*, not *what this is* |
| `tools` | the tool allowlist for the child. Narrower is better; a read-only reviewer that cannot write cannot "helpfully" fix things |
| `model` | a tier name, or a provider-qualified id to pin deliberately. **A bare id is rejected everywhere** — `bin/pi-check` `PC-04` and `PC-08` |
| `egress` | the ceiling. Checked at load against the tier's provider class |
| `returns` | `object` for a structured report, matching a schema in `config/schemas/` where one exists |
| `isolation` | `worktree` to run the agent in its own git worktree — see [worktree](../extensions/worktree.md) |

Twelve agents ship: `ai-engineer`, `app-builder`, `architect-reviewer`, `code-reviewer`,
`data-engineer`, `debugger`, `docs-architect`, `frontend-developer`, `local-llm-engineer`,
`prompt-engineer`, `researcher`, `security-reviewer`. They are ordinary Markdown — read one before
writing your own.

!!! tip "The disambiguation rule for `model`"
    **A value containing `/` is a provider-qualified id. Anything else is a tier name.** A bare id
    such as `sonnet` or `gpt-5.4` is forbidden everywhere, because providers expose overlapping ids
    and an unqualified one resolves by accident.

See [Adding a sub-agent](../extending/subagents.md) for the walkthrough.

---

## Verifying a change

```bash
bin/pi-check --all     # PC-04 agent frontmatter, PC-08 bare ids
```

In a session, `/agents` prints the resolved agent list *and* the sub-agent model-selection block
the model sees — verbatim the same text. `/doctor`'s `D-03` reports any agent name mentioned in
instruction text that has no file.

## Related

- [Adding a sub-agent](../extending/subagents.md)
- [`routing.json`](routing.md) — the tiers the frontmatter names
- [dispatch](../extensions/dispatch.md), [teammates](../extensions/teammates.md),
  [jobs](../extensions/jobs.md)
