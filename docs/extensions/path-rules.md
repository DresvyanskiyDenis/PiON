# `path-rules` — context rules scoped to a path glob

`AGENTS.md` and `PRIVATE.md` are flat. A rule written there is in the system prompt on every turn of
every session, or it is nowhere — there is no way to say "this applies once the agent is working on
a Terraform file." That is the gap this module closes.

A rule is one Markdown file in a `rules/` directory, with an optional `paths:` list in its
frontmatter:

```markdown
---
paths:
  - "**/*.py"
  - "**/pyproject.toml"
---

Use `uv` for every Python invocation in this project. Never `pip`, never a bare `python`.
```

No `paths:` key at all means unconditional — always injected, exactly like a line in `AGENTS.md`.

## Where the rules live, and why not in this repo

`~/.pi/agent/rules`, or wherever `$PI_CONFIG_RULES_DIR` points. Deliberately **outside** the
repository: the format is Claude Code's own, so the same directory can be symlinked into both
harnesses instead of maintaining two copies of the same rule text. Nothing here is added to
`.gitignore` and nothing is added to `config/settings.json`; if you want your rules tracked, you
symlink your own directory in.

An absent directory is a normal, unconfigured install — zero rules, no warning. A single rule file
with a bad `---` block, invalid YAML or an unsupported glob is dropped with a loud warning and
**every other file still loads**: a typo in one rule must not disable the rest.

## Why this is four mechanisms and not one

The obvious design is to watch `tool_call` and inject the matching rule lazily. It has a hole that
does not show up until the *following* turn, and both halves of it were traced against the pinned
0.84.0 package rather than assumed:

**`tool_call` can only block, never inject.** Its result type carries a veto and nothing else.
There is no field on it that adds text to the turn — and by the time it fires, the turn's context is
already assembled. A rule matched there arrives after the edit it was meant to govern.

**`before_agent_start` fires once, before the turn loop starts.** So it cannot see a file the model
touches partway through a turn. "Read a file, then edit it, same turn" is not one round trip late
under a `before_agent_start`-only design — it is invisible until the next turn.

The detection point and the injection point are therefore different events, which is what the four
layers are for:

| # | Event | Job |
|---|---|---|
| 1 | `session_start` | A bounded walk of the project seeds the rule set from files that **already exist**. The primary path: the rule is in the system prompt before the model's first token. |
| 2 | `tool_call` on `read`/`edit`/`write` | Detects a file the startup scan could not have seen. Observes only — it always returns `undefined` and must never become a second way to block a call. |
| 3 | `context` | Fires before **every** LLM call within a turn, including mid-turn after a tool result. This is what actually delivers a rule detected by (2) before the model's next action. |
| 4 | `before_agent_start` | The durable net, recomputed live each turn, so the block survives compaction, `/reload` and fork. |

Layers 3 and 4 do not double-inject: `before_agent_start` clears the pending set the moment it folds
it into the system prompt, so `context` only ever carries what surfaced *after* that point.

!!! note "The `context` injection appends at the tail, on purpose"
    Prompt caching is prefix-based. A tail append after the real conversation costs nothing against
    the cache; a mid-array insert nearer whatever the note is about would invalidate every cached
    prefix behind it. The placement is load-bearing, not an oversight.

## The startup scan is bounded

`.git`, `node_modules`, `.venv`, `dist` and `__pycache__` are skipped outright, depth and total
files visited are both capped, and the walk stops the moment every conditional rule has activated —
a repository where everything matches early costs nothing to keep scanning. If the scan truncates or
runs over its 100 ms reporting budget it says so; it never silently gives up.

## Supported glob syntax, and nothing more

`**`, `*`, `?`, and one level of `{a,b,c}` brace expansion. Character classes, extglob, negation and
nested braces throw at load time, naming the offending pattern.

That refusal is the point. A pattern that silently failed to match would be strictly worse than one
that refuses to load, because you would never find out your rule stopped firing. Brace expansion
happens once, at compile time, into a flat pattern list — the same internal shape Claude Code's own
engine derives from a `paths:` list.

## Related
[`AGENTS.md` and instruction files](../configuration/settings.md) · [path-defaults](path-defaults.md) ·
[session-context](session-context.md) · [Architecture](../concepts/architecture.md)
