# `worktree` — detection, isolation, crash-safe cleanup

The `/worktree` command (add, switch, remove, prune, its interactive menu) belongs to an adopted
package. This module does the three things no package covers.

## 1. Detection

At `session_start`: `git rev-parse --git-common-dir`. A result that is not `.git` means the session
is **already inside a linked worktree**.

Published three ways — the statusline, the shared extension bus, and a module-level getter that
[`session-context`](session-context.md) and [`session-index`](session-index.md) import directly.

The reason to detect rather than assume: a harness that creates a worktree for a session that is
already in one **nests**, and nested worktrees are a mess to clean up.

## 2. A worktree provider for `isolation: worktree`

An agent declaring `isolation: worktree` in its frontmatter runs in its own tree.

- If the session is **already** inside a worktree, that worktree is **reused** — never nested.
- If the session is in the primary checkout, a fresh one is created.

## 3. Crash-safe cleanup

!!! abstract "The registry entry is written BEFORE `git worktree add` runs"
    This is the whole trick. A `finally` block does not survive `kill -9`, a panic, or a laptop
    lid closing. A registry entry written first does.

    The cost is an occasional entry for a worktree that was never created, which the sweep handles
    trivially. The alternative cost is an orphaned worktree nobody knows about.

Cleanup runs as a full registry sweep at every `session_start`, plus an **eager release** the moment
an isolated tool call settles — so a long session doing many isolated dispatches does not accumulate
one worktree per dispatch until it finally exits.

## The one rule

!!! danger "Never `rm -rf` a dirty tree"
    This is the one rule the module cannot get wrong. A worktree with uncommitted changes is
    somebody's work. The sweep leaves it and says so.

## Related
[dispatch](dispatch.md) · [`dispatch.json`](../configuration/dispatch.md) ·
[Adding a sub-agent](../extending/subagents.md)
