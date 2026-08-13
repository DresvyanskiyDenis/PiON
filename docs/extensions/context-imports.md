# `context-imports` — `@path` imports and lazy nested instructions

Two related behaviours.

## 1. `@path` expansion

A bare `@path`, **alone on its own line**, inside an instruction file — or inside the
already-assembled system prompt — is expanded in place with the target file's content.

| Rule | Behaviour |
|---|---|
| Resolution | relative to the **importing file** for a nested import; relative to `cwd` for an import found directly in the top-level prompt, since the prompt text has no single file of origin |
| Code spans | skipped inside fenced and inline code — so documenting `@path` does not trigger it |
| Recursion | depth-capped |
| Repeats | memoized per session |
| A missing import | announced **exactly once** |

"Alone on its own line" is the whole safety of the feature: an email address in prose is not an
import.

## 2. Lazy nested instruction files

The first `read` / `edit` / `write` of a file in a subdirectory below `cwd` lazily loads that
subdirectory's — and every intervening subdirectory's — `AGENTS.md` / `CLAUDE.md`. First hit per
directory wins, at most once per directory per session, delivered for the **next** turn.

`cwd`'s own instructions are already in the base system prompt via PI's own context-file loading and
are not reloaded.

The alternative designs are both worse: loading every nested instruction file eagerly costs context
for directories you never touch, and loading none means a monorepo's per-package conventions are
invisible until you paste them in.

## Related
[session-context](session-context.md) · [compaction](compaction.md#3-pinned-block-regeneration)
