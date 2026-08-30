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

A rule may also answer with a **tool mask** rather than with text, by naming one in `mask:`:

```markdown
---
paths:
  - "**/*.env"
mask: review
---

Touching a secret file drops the write side of the tool list for the rest of this turn.
```

Touching a matching file narrows the tool surface for the rest of the turn and injects nothing;
`turn_end` releases it. `mask:` requires `paths:`, and a value naming no real mask drops that one
rule with a warning. Such a rule is outside the startup scan and outside the dedupe below, because
it answers "is the model touching one right now" rather than "does this project contain such a
file". See [tool-masks](tool-masks.md).

## Where the rules live, and why not in this repo

`~/.pi/agent/rules`, or wherever `$PI_CONFIG_RULES_DIR` points. Deliberately **outside** the
repository: the format is Claude Code's own, so the same directory can be symlinked into both
harnesses instead of maintaining two copies of the same rule text. Nothing here is added to
`.gitignore` and nothing is added to `config/settings.json`; if you want your rules tracked, you
symlink your own directory in.

An absent directory is a normal, unconfigured install — zero rules, no warning. A single rule file
with a bad `---` block, invalid YAML or an unsupported glob is dropped with a loud warning and
**every other file still loads**: a typo in one rule must not disable the rest.

## Why this is three mechanisms and not one

The obvious design is to watch `tool_call` and inject the matching rule lazily. It has a hole that
does not show up until the *following* turn, and both halves of it were traced against the pinned
0.84.0 package rather than assumed:

**`tool_call` can only block, never inject.** Its result type carries a veto and nothing else.
There is no field on it that adds text to the turn — and by the time it fires, the turn's context is
already assembled. A rule matched there arrives after the edit it was meant to govern.

**`before_agent_start` fires once, before the turn loop starts.** So it cannot see a file the model
touches partway through a turn. "Read a file, then edit it, same turn" is not one round trip late
under a `before_agent_start`-only design — it is invisible until the next turn.

The detection point and the injection point are therefore different events, which is what the three
layers are for:

| # | Event | Job |
|---|---|---|
| 1 | `session_start` | A bounded walk of the project seeds the rule set from files that **already exist**. The primary path: the rule is in context before the model's first token. |
| 2 | `tool_call` on `read`/`edit`/`write` | Detects a file the startup scan could not have seen. Observes only — it always returns `undefined` and must never become a second way to block a call. |
| 3 | `context` | The only delivery path. It fires before **every** LLM call — the first of a turn, every mid-turn call after a tool result, and every call after a compaction, `/reload` or fork — and it carries the **whole** active rule set each time. |

There is no fourth layer, and the missing one is the point.

!!! warning "Why the rule block is not in the system prompt"
    It used to be, on the reasoning that the system prompt is the durable surface. It is durable,
    and it is also the head of the provider's **cached prefix**. The active rule set grows as the
    session touches files, so every newly activated rule rewrote that block — invalidating the
    cache for the system prompt *and the entire conversation behind it*, a full-context re-write at
    cache-write rates, bought by nothing more than the model reading its first `.py` file.

    The `context` tail-append costs the opposite: the note lands after the last real message, so a
    change to it invalidates only itself. Re-sending the whole set every call is free there, and it
    is what lets the "already sent" bookkeeping disappear entirely — one delivery path, nothing to
    fall out of step with the wire. See
    [prompt-cache limits](../limitations.md#prompt-cache-limits--what-moves-the-cached-prefix).

    A mask rule is the standing exception in the other direction: it moves the *tool roster*, which
    is also prefix, and that cost is accepted because a capability cannot be made absent any other
    way.

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
[Prompt-cache limits](../limitations.md#prompt-cache-limits--what-moves-the-cached-prefix) ·
[tool-masks](tool-masks.md) ·
[session-context](session-context.md) · [Architecture](../concepts/architecture.md)
